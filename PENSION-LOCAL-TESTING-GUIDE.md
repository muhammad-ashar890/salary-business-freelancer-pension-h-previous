# Pension Merge — Local Testing Guide (PC)

Folder: unzip `tr-pension-merge-branch.zip` into a **new separate folder** (e.g. `D:\tr-pension-test`). Do NOT overwrite your working project folder — `main` stays untouched that way.

## Setup (5 min)

```powershell
cd D:\tr-pension-test
# copy .env from your current working clone of this project (same DB settings are fine — NO prisma migration in this merge, schema unchanged)
Copy-Item D:\<your-current-clone>\.env .\.env
npm ci --ignore-scripts
npx prisma generate
```

Terminal 1 (web app):
```powershell
npm run dev
```

Terminal 2 (desktop agent, only when you reach the FBR step):
```powershell
cd electron-connect
npm install   # first time only
.\start-live.ps1
```

## Test 0 — pehle tasdeeq: baqi filings kharab to nahi huin (sab se pehle ye)

1. Apni aik mojooda **salary** (ya business/freelancer) draft kholen.
2. Tax Calculate karen → Packet generate karen.
3. Rakamain pehle jaisi hi honi chahiye. (Test suites ne to keh diya hai theek hai, phir bhi aankhon se dekhna sab se behter hai.)

## Test 1 — Pension 12M (final-tax case, synthetic fixture se)

1. New filing: TY2026, income source = **sirf Pension**.
2. Pension step par sawal ayega "Do you currently work for your former employer..." → **No** select karen. (Jawab diye baghair Continue disable rahay ga — yahi intended hai.)
3. Profile/CNIC par **date of birth** lazmi ho (CNIC upload ya profile field) — age band wahi se aata hai.
4. Documents me ye file upload karen: `test-fixtures\pension\SYNTHETIC-Pension-12M-TY2026.pdf` (fictional QA statement: gross 12,000,000, medical 0, tax deducted 0).
5. Extract → Review → fields check karen → **Save & Approve Map**.
6. Calculate Tax → expected: **Base tax 100,000 + Surcharge 10,000 = Tax due 110,000** (2M excess par 5%, phir 10% §4AB).
7. Packet generate karen → PDF kholen → "Reviewed Annual Pension Source" section check karen.
8. FBR step: agent (start-live.ps1) se supervised run karen. IRIS me verify karen:
   - Row **1008**: Total Amount 12,000,000 · Subject to Exemption 10,000,000 · Subject to Final Tax 2,000,000
   - **Tax Deductions → "Final Tax"** grid → 64020007: Taxable Amount 2,000,000 · Tax Deducted 0
   - **Computations** → 923184 surcharge 10,000 (portal khud calculate karta hai; agent readback verify karta hai)

## Test 2 — Pension 10M se kam (exempt case)

Usi flow me review screen par Gross ko edit karke **1,989,000** kar dein (medical 0 rakhen) → Save & Approve Map dobara → Calculate → **Tax 0** ana chahiye; IRIS 1008: Total = Exemption = 1,989,000, Final = 0. (IRIS ko salary slab nahi lagana chahiye.)

## Test 3 — "Yes" jawab (salary treatment)

Answer **Yes** kar ke calculate karen → pension salary slabs se price hogi; 1008 me Exemption 0 honi chahiye.

## Test 4 — Safety checks (ye rukna hi chahiye)

- Pension Tax Deducted blank chor kar map karen → map ho jayega, lekin **calculation rukni chahiye** ("Unknown withholding is not zero").
- Mapped pension statement edit karen → calculation/packet invalidate ho jana chahiye (dubara Save & Approve Map + recalculate mangna chahiye).
- Profile CNIC/DOB change karen → pension packet invalidate ho jana chahiye.

## Optional — test suites local par bhi chala kar dekhen

```powershell
npm run verify:pension-routing
npm run verify:pension-review      # review-policy + statement + prefill + doc-review
node scripts/sanity-pension-yes-no.cjs
```

## Agar kuch ghalat lage to mujhe ye bhejen

1. Kis step par ruka / kya error aya (screenshot best hai)
2. Agent job report / browser console ka error text
3. Kaun sa test case tha (Test 0/1/2/3/4)

Main usi k hissab se fix kar dunga. Kuch bhi break lage to sirf folder band kar dein — aapka asal project folder is se alag aur mehfooz hai.
