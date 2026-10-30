// Read-only export. Run from the WEB APP project root, not electron-connect.
// node export-filing-packet.cjs "YOUR_DRAFT_ID" 10
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const projectRequire = createRequire(path.join(process.cwd(), 'package.json'));
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
async function main() {
  const draftId = String(process.argv[2] || '').trim();
  const version = Number(process.argv[3] || '10');
  if (!draftId || !Number.isSafeInteger(version) || version < 1) {
    console.error('Usage: node export-filing-packet.cjs "DRAFT_ID_FROM_FILING_URL" 10');
    process.exitCode = 1; return;
  }
  const { PrismaClient } = projectRequire('@prisma/client');
  const db = new PrismaClient();
  try {
    const packet = await db.filingPacket.findUnique({
      where: { filingDraftId_version: { filingDraftId: draftId, version } },
      select: { id: true, filingDraftId: true, version: true, packetHash: true, createdAt: true, approvalStatus: true, snapshotJson: true }
    });
    if (!packet) throw new Error('No packet found for this draft/version. No data was changed.');
    const { snapshotJson, ...metadata } = packet;
    const output = { ...metadata, snapshot: JSON.parse(snapshotJson) };
    const file = path.join(process.cwd(), `filing-packet-v${version}-${packet.id}.json`);
    fs.writeFileSync(file, JSON.stringify(output, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log('Exported existing packet (database read only): ' + file);
    console.log('Hash: ' + packet.packetHash);
    console.log('Contains private tax/document data. Review and redact secrets or signed URLs before sharing.');
  } finally { await db.$disconnect(); }
}
main().catch(() => {
  console.error('Export failed. Check the web-app project folder, local .env/database access, draft ID and packet version; also check whether the output already exists. No database write was performed.');
  process.exitCode = 1;
});
