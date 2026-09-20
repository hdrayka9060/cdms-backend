/**
 * BHPH EMI math — pure functions, no Mongoose/Nest deps so they're unit-testable
 * and shareable. All rates are ANNUAL percentages (e.g. 12 = 12%/yr); the
 * monthly rate used inside the amortization formula is `rate / 100 / 12`.
 *
 * Standard reducing-balance EMI:
 *   EMI = P·r·(1+r)^n / ((1+r)^n − 1)      (r = monthly rate, n = term months)
 *
 * The three loan levers — interest rate, term, and EMI — are interdependent:
 * given the principal and ANY TWO of them, the third is determined. `solveEmi`
 * is the single entry point the create/preview flows use.
 */

export interface EmiInputs {
  /** Financed amount (price − down payment). Must be > 0. */
  principal: number;
  /** Annual interest rate percent. */
  interestRatePercent?: number;
  termMonths?: number;
  emiAmount?: number;
}

export interface EmiSolved {
  principal: number;
  interestRatePercent: number;
  termMonths: number;
  emiAmount: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** EMI from principal + annual rate% + term months. */
export function calcEmi(principal: number, ratePercent: number, termMonths: number): number {
  if (!(principal > 0)) throw new Error('Principal must be greater than 0');
  if (!(termMonths > 0)) throw new Error('Term must be at least 1 month');
  const r = ratePercent / 100 / 12;
  if (r === 0) return principal / termMonths;
  const pow = Math.pow(1 + r, termMonths);
  return (principal * r * pow) / (pow - 1);
}

/**
 * Term (months) from principal + annual rate% + EMI.
 *   n = ln(EMI / (EMI − P·r)) / ln(1 + r)
 * Requires EMI > P·r, otherwise the balance never reduces (loan never repays).
 * Returned rounded UP to a whole month so the schedule fully covers the debt.
 */
export function calcTerm(principal: number, ratePercent: number, emi: number): number {
  if (!(principal > 0)) throw new Error('Principal must be greater than 0');
  if (!(emi > 0)) throw new Error('EMI must be greater than 0');
  const r = ratePercent / 100 / 12;
  if (r === 0) return Math.ceil(principal / emi);
  const monthlyInterest = principal * r;
  if (emi <= monthlyInterest) {
    throw new Error(
      `EMI ($${round2(emi)}) is too low to ever repay the principal at ${ratePercent}%/yr ` +
        `(monthly interest alone is $${round2(monthlyInterest)}). Increase the EMI or lower the rate.`,
    );
  }
  const n = Math.log(emi / (emi - monthlyInterest)) / Math.log(1 + r);
  return Math.max(1, Math.ceil(n - 1e-9));
}

/**
 * Annual rate% from principal + term + EMI. No closed form → bisection on the
 * monthly rate. `calcEmi` is monotonically increasing in r, so bisection is
 * safe and converges fast. Returns 0 when the EMI implies no interest.
 */
export function calcRate(principal: number, termMonths: number, emi: number): number {
  if (!(principal > 0)) throw new Error('Principal must be greater than 0');
  if (!(termMonths > 0)) throw new Error('Term must be at least 1 month');
  if (!(emi > 0)) throw new Error('EMI must be greater than 0');

  const zeroRateEmi = principal / termMonths;
  // EMI at least covers principal/term with no interest. Below that it can never
  // repay in the given term.
  if (emi <= zeroRateEmi + 1e-9) {
    if (emi < zeroRateEmi - 1e-6) {
      throw new Error(
        `EMI ($${round2(emi)}) is below the interest-free installment ($${round2(zeroRateEmi)}) ` +
          `for a ${termMonths}-month term — it can't repay the loan in that time.`,
      );
    }
    return 0;
  }

  let lo = 0; // 0%/month
  let hi = 1; // 100%/month (1200%/yr) — far above any real BHPH rate
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const guess = calcEmi(principal, mid * 1200, termMonths);
    if (guess > emi) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  return round2(((lo + hi) / 2) * 1200);
}

/**
 * Given the principal and exactly TWO of {rate, term, EMI}, fill in the third
 * and return the complete, canonical set (EMI rounded to cents). Throws a
 * descriptive error when the inputs are unsolvable or not exactly two are
 * supplied. This is what the create + preview endpoints call.
 */
export function solveEmi(inputs: EmiInputs): EmiSolved {
  const { principal } = inputs;
  if (!(principal > 0)) throw new Error('Principal must be greater than 0');

  const hasRate = inputs.interestRatePercent !== undefined && inputs.interestRatePercent !== null;
  const hasTerm = inputs.termMonths !== undefined && inputs.termMonths !== null;
  const hasEmi = inputs.emiAmount !== undefined && inputs.emiAmount !== null;
  const provided = [hasRate, hasTerm, hasEmi].filter(Boolean).length;

  if (provided < 2) {
    throw new Error('Provide at least two of: interest rate, term, EMI (the third is calculated).');
  }

  let rate = hasRate ? Number(inputs.interestRatePercent) : undefined;
  let term = hasTerm ? Number(inputs.termMonths) : undefined;
  let emi = hasEmi ? Number(inputs.emiAmount) : undefined;

  if (rate !== undefined && (rate < 0 || rate > 100)) {
    throw new Error('Interest rate must be between 0 and 100%.');
  }
  if (term !== undefined && term < 1) throw new Error('Term must be at least 1 month.');

  // All three supplied → trust rate + term as the canonical pair, recompute EMI.
  if (rate !== undefined && term !== undefined) {
    emi = calcEmi(principal, rate, term);
  } else if (rate !== undefined && emi !== undefined) {
    term = calcTerm(principal, rate, emi);
    emi = calcEmi(principal, rate, term); // recompute for the rounded term
  } else if (term !== undefined && emi !== undefined) {
    rate = calcRate(principal, term, emi);
    emi = calcEmi(principal, rate, term);
  }

  return {
    principal: round2(principal),
    interestRatePercent: rate as number,
    termMonths: term as number,
    emiAmount: round2(emi as number),
  };
}

export interface AmortizationRow {
  installmentNo: number;
  dueDate: Date;
  emiAmount: number;
  principalPart: number;
  interestPart: number;
  balance: number;
}

/**
 * Build the full reducing-balance amortization table. Pure — takes primitives so
 * it can be reused by the service (schedule endpoint) and by the payment
 * principal/interest split (Phase 2/3).
 */
export function buildAmortization(
  principal: number,
  ratePercent: number,
  termMonths: number,
  emiAmount: number,
  startDate: Date,
): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  const r = ratePercent / 100 / 12;
  let balance = principal;
  const start = new Date(startDate);
  for (let i = 1; i <= termMonths; i++) {
    const interest = balance * r;
    let principalPart = emiAmount - interest;
    // Final installment: clamp so rounding drift doesn't leave a few cents.
    if (i === termMonths || principalPart > balance) principalPart = balance;
    balance -= principalPart;
    const dueDate = new Date(start);
    dueDate.setMonth(dueDate.getMonth() + i);
    rows.push({
      installmentNo: i,
      dueDate,
      emiAmount: round2(principalPart + interest),
      principalPart: round2(principalPart),
      interestPart: round2(interest),
      balance: Math.max(0, round2(balance)),
    });
  }
  return rows;
}
