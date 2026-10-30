"use server";
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getDocumentReviewRequiredErrors } from '@/lib/tax/document-review-required';
import { normalizeBusinessListFieldsForStorage } from '@/lib/tax/business-list-fields';
import { invalidateBusinessBalancePackets } from '@/lib/tax/business-filing';
import { consumeRateLimit } from '@/lib/rate-limit';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, unlink } from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';

/** Creates an explicitly user-declared source, never an AI-extracted or bank-issued document. */
export async function saveManualBusinessRecordAction(draftId:string,documentType:string,fields:{label:string;value:string|number|boolean|null}[],confirmed:boolean) {
  let storedPath=''; let committed=false;
  try {
    if(!confirmed || !['business_books','business_balance_sheet','business_support'].includes(documentType)) throw new Error('Confirm your declaration and choose a supported business source.');
    if(!Array.isArray(fields) || fields.length>120 || fields.some(f=>!f || typeof f.label!=='string' || f.label.length>150 || (f.value!==null && !['string','number','boolean'].includes(typeof f.value)) || String(f.value??'').length>12000)) throw new Error('Invalid manual business fields.');
    const session=await getServerSession(authOptions); if(!session?.user?.email) throw new Error('Unauthorized');
    const user=await prisma.user.findUnique({where:{email:session.user.email},select:{id:true}});if(!user)throw new Error('Unauthorized');
    const draft=await prisma.filingDraft.findFirst({where:{id:draftId,userId:user.id}});
    if(!draft || draft.filerType!=='myself' || draft.taxYear!==2026 || !JSON.parse(draft.incomeSources).includes('business'))throw new Error('Supported business filing not found.');
    if(!fields.some(f=>f.value!==null && String(f.value).trim()!==''))throw new Error('Enter at least one known fact.');
    const storage=normalizeBusinessListFieldsForStorage({fields},draft.taxYear);if(storage.errors.length)throw new Error(storage.errors.join(' '));
    const reviewFields=(storage.payload as {fields:typeof fields}).fields;
    const errors=getDocumentReviewRequiredErrors(documentType,reviewFields,draft.taxYear);if(errors.length)throw new Error(errors.join(' '));
    const limit=consumeRateLimit(`manual-business:${user.id}`,12,60000); if(!limit.allowed)throw new Error('Too many saves; wait before trying again.');
    const bytes=await new Promise<Buffer>((resolve,reject)=>{
      const doc=new PDFDocument({margin:45});const chunks:Buffer[]=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
      doc.fontSize(16).text('User-declared business record');doc.fontSize(10).text('Manually entered and confirmed by the signed-in taxpayer. Not third-party evidence, not AI extraction.');
      doc.text(`Tax year: ${draft.taxYear} | Source: ${documentType}`);doc.moveDown();
      for(const f of reviewFields)if(f.value!==null && String(f.value).trim()!=='')doc.text(`${f.label}: ${f.value}`);
      doc.end();
    });
    const filename=`manual-${documentType}-${randomUUID()}.pdf`;
    const dir=path.join(process.cwd(),'uploads');await mkdir(dir,{recursive:true});storedPath=path.join(dir,filename);await writeFile(storedPath,bytes);
    const document=await prisma.$transaction(async tx=>{
      const existing=await tx.document.findFirst({where:{filingDraftId:draft.id,userId:user.id,documentType,bankAccountId:null},select:{id:true}});
      if(existing)throw new Error('A source already exists in this slot. Edit its reviewed fields instead of creating a second record.');
      const row=await tx.document.create({data:{filingDraftId:draft.id,userId:user.id,documentType,fileName:`User-declared ${documentType}.pdf`,fileUrl:filename,mimeType:'application/pdf',sizeBytes:bytes.length,extractionStatus:'COMPLETED',extractionProvider:'USER_DECLARED',extractedAt:new Date(),extractedData:JSON.stringify({documentType,fields:reviewFields,notes:['Manual declaration; no original source uploaded.'],sourceMode:'USER_DECLARED',declaredAt:new Date().toISOString()})},select:{id:true}});
      await invalidateBusinessBalancePackets(tx,draft.id,user.id);return row;
    },{isolationLevel:'Serializable'});committed=true;
    return {success:true as const,documentId:document.id};
  } catch(e) { if(storedPath && !committed)await unlink(storedPath).catch(()=>{});return {success:false as const,error:e instanceof Error?e.message:'Could not save declaration.'}; }
}
