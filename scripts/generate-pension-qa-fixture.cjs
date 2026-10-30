#!/usr/bin/env node
// Reproducible, clearly fictional upload fixture. No real identity or official branding.
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");
const fixture = require("../test-fixtures/pension/above-10m-ty2026.json");
const output = path.resolve(process.argv[2] || path.join(__dirname, "../test-fixtures/pension/SYNTHETIC-Pension-12M-TY2026.pdf"));
fs.mkdirSync(path.dirname(output), { recursive: true });
const stream = fs.createWriteStream(output);
const pdf = new PDFDocument({
  size: "A4", margin: 0, autoFirstPage: true,
  info: {
    Title: "SYNTHETIC QA ONLY - Annual Pension Statement - TY2026 - PKR 12,000,000",
    Author: "Tax Rocket QA Fixtures (Fictional)",
    Subject: "Not for submission, identification, financial use, or evidence of real income",
    Keywords: "synthetic, fictional, test data, pension, TY2026, 12000000",
    CreationDate: new Date("2026-07-05T00:00:00Z"),
    ModDate: new Date("2026-07-05T00:00:00Z"),
  },
});
pdf.pipe(stream);
const color = { ink: "#173242", muted: "#586976", teal: "#075D66", light: "#F1F7F8", line: "#DCE6E8", amber: "#FFF1CF", amberInk: "#805108" };
const width = pdf.page.width;
const left = 36, content = width - 72;
const money = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
function text(value, x, y, options = {}) {
  const { size = 10, bold = false, fill = color.ink, ...rest } = options;
  pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(fill).text(String(value), x, y, { lineBreak: false, ...rest });
}
function line(x1, y1, x2, y2, stroke = color.line) {
  pdf.moveTo(x1, y1).lineTo(x2, y2).lineWidth(0.6).strokeColor(stroke).stroke();
}
// Conspicuous, non-official marking; no government emblem, real signature or bank logo.
pdf.roundedRect(left, 26, content, 28, 5).fill(color.amber);
text("SYNTHETIC QA FIXTURE  /  NOT FOR SUBMISSION", left + 12, 35, { size: 10, bold: true, fill: color.amberInk });
text(fixture.issuer.toUpperCase(), left, 75, { size: 9, bold: true, fill: color.teal });
text("Annual Pension Statement", left, 96, { size: 22, bold: true });
text("Fictional payment record  |  Annual amounts in Pakistan Rupees (PKR)", left, 126, { size: 9, fill: color.muted });

pdf.roundedRect(left, 153, content, 94, 6).fill(color.light);
text("PENSIONER", left + 12, 166, { size: 8, fill: color.muted });
text(fixture.pensionerName, left + 12, 181, { size: 11, bold: true });
text("PPO NUMBER", left + 12, 210, { size: 8, fill: color.muted });
text(fixture.ppoNumber, left + 12, 225, { size: 10 });
const rightX = left + 320;
text("TAX YEAR", rightX, 166, { size: 8, fill: color.muted });
text(fixture.taxYear, rightX, 181, { size: 13, bold: true });
text("REPORTING PERIOD", rightX, 210, { size: 8, fill: color.muted });
text("01 Jul 2025 - 30 Jun 2026", rightX, 225, { size: 9 });

text("ANNUAL PAYMENT SUMMARY", left, 267, { size: 11, bold: true, fill: color.teal });
pdf.rect(left, 287, content, 25).fill(color.teal);
text("Printed statement fact", left + 12, 295, { size: 9, bold: true, fill: "#FFFFFF" });
text("Annual amount (PKR)", left + 360, 295, { size: 9, bold: true, fill: "#FFFFFF", width: content - 372, align: "right" });
const facts = [
  ["Gross Pension (Annual PKR)", fixture.annualGross],
  ["Medical Allowance (Annual PKR)", fixture.annualMedical],
  ["Pension Tax Deducted (Annual PKR)", fixture.annualTaxDeducted],
  ["Net Pension Payable (Annual PKR)", fixture.annualNetPaid],
];
facts.forEach(([label, value], index) => {
  const y = 312 + index * 31;
  if (index % 2 === 0) pdf.rect(left, y, content, 31).fill("#F5F8F9");
  text(label, left + 12, y + 10, { size: 10, bold: index === 0 || index === 3 });
  text(money(value), left + 360, y + 9, { size: 12, bold: true, width: content - 372, align: "right" });
  line(left, y + 31, left + content, y + 31);
});

text("MONTHLY PAYMENT SCHEDULE", left, 459, { size: 11, bold: true, fill: color.teal });
const columns = [
  { label: "Month", x: left + 8, w: 92, align: "left" },
  { label: "Gross PKR", x: left + 100, w: 100, align: "right" },
  { label: "Medical PKR", x: left + 204, w: 88, align: "right" },
  { label: "Tax deducted PKR", x: left + 296, w: 106, align: "right" },
  { label: "Net paid PKR", x: left + 406, w: content - 414, align: "right" },
];
pdf.rect(left, 482, content, 22).fill("#E7F0F2");
for (const col of columns) text(col.label, col.x, 489, { size: 8, bold: true, width: col.w, align: col.align });
for (let i = 0; i < 12; i++) {
  const date = new Date(Date.UTC(2025, 6 + i, 1));
  const month = date.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const values = [month, money(fixture.monthlyGross), "0", "0", money(fixture.monthlyGross)];
  const y = 504 + i * 18;
  if (i % 2 === 0) pdf.rect(left, y, content, 18).fill("#F5F8F9");
  columns.forEach((col, j) => text(values[j], col.x, y + 5, { size: 8.5, width: col.w, align: col.align }));
}
line(left, 720, left + content, 720);
pdf.font("Helvetica").fontSize(8.5).fillColor(color.muted).text(
  "QA scenario: medical allowance and tax deducted are explicitly NIL (0). All twelve monthly payments are included. The nil deduction is a test input, not a conclusion that the pension is tax-exempt. No CNIC or date of birth is printed.",
  left, 737, { width: content, lineGap: 2 },
);
line(left, 784, left + content, 784);
text("FICTIONAL FIGURES. Not evidence of real income. No official certification or signature.", left, 795, { size: 8, bold: true, fill: color.amberInk });
text(`Prepared: ${fixture.preparedDate}  |  QA-PENSION-12M  |  Page 1 of 1`, left, 810, { size: 7.5, fill: color.muted });
pdf.end();
stream.on("finish", () => console.log(output));
stream.on("error", (error) => { console.error(error); process.exitCode = 1; });
