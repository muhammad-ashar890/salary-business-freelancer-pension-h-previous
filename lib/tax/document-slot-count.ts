/** Count occupied visible slots, including optional slots and each bank account. */
export function countUploadedDocumentSlots(
  slots: readonly { documentType: string; slotKey?: string }[],
  uploaded: Readonly<Record<string, string>>,
): number {
  return slots.filter((slot) => Boolean(uploaded[slot.slotKey ?? slot.documentType])).length;
}
