import { buildAmortization, calcEmi, calcRate, calcTerm, solveEmi } from './emi-math';

describe('emi-math', () => {
  describe('calcEmi', () => {
    it('matches the standard amortization formula', () => {
      // $10,000 @ 12%/yr for 24 months → ~$470.73/mo
      expect(calcEmi(10000, 12, 24)).toBeCloseTo(470.73, 1);
    });
    it('handles a 0% loan as straight-line principal / term', () => {
      expect(calcEmi(12000, 0, 24)).toBe(500);
    });
    it('rejects non-positive principal / term', () => {
      expect(() => calcEmi(0, 10, 12)).toThrow();
      expect(() => calcEmi(1000, 10, 0)).toThrow();
    });
  });

  describe('calcTerm (inverse of calcEmi for n)', () => {
    it('recovers the term from principal + rate + EMI', () => {
      const emi = calcEmi(10000, 12, 24);
      expect(calcTerm(10000, 12, emi)).toBe(24);
    });
    it('handles 0% as ceil(principal / emi)', () => {
      expect(calcTerm(12000, 0, 500)).toBe(24);
    });
    it('throws when EMI cannot cover monthly interest', () => {
      // 10000 @ 12%/yr → monthly interest $100; an EMI of $80 never amortizes.
      expect(() => calcTerm(10000, 12, 80)).toThrow(/too low/i);
    });
  });

  describe('calcRate (numeric inverse for r)', () => {
    it('recovers the rate from principal + term + EMI', () => {
      const emi = calcEmi(10000, 12, 24);
      expect(calcRate(10000, 24, emi)).toBeCloseTo(12, 1);
    });
    it('returns 0 when the EMI implies no interest', () => {
      expect(calcRate(12000, 24, 500)).toBe(0);
    });
    it('throws when EMI is below the interest-free installment', () => {
      expect(() => calcRate(12000, 24, 400)).toThrow();
    });
  });

  describe('solveEmi (any 2 → 3rd)', () => {
    it('fills EMI from rate + term', () => {
      const s = solveEmi({ principal: 10000, interestRatePercent: 12, termMonths: 24 });
      expect(s.emiAmount).toBeCloseTo(470.73, 1);
      expect(s.termMonths).toBe(24);
      expect(s.interestRatePercent).toBe(12);
    });
    it('fills term from rate + EMI', () => {
      const emi = calcEmi(10000, 12, 24);
      const s = solveEmi({ principal: 10000, interestRatePercent: 12, emiAmount: emi });
      expect(s.termMonths).toBe(24);
    });
    it('fills rate from term + EMI', () => {
      const emi = calcEmi(10000, 12, 24);
      const s = solveEmi({ principal: 10000, termMonths: 24, emiAmount: emi });
      expect(s.interestRatePercent).toBeCloseTo(12, 1);
    });
    it('all three supplied → rate+term are canonical, EMI recomputed', () => {
      const s = solveEmi({ principal: 10000, interestRatePercent: 12, termMonths: 24, emiAmount: 999 });
      expect(s.emiAmount).toBeCloseTo(470.73, 1);
    });
    it('throws when fewer than two are supplied', () => {
      expect(() => solveEmi({ principal: 10000, interestRatePercent: 12 })).toThrow(/two of/i);
    });
  });

  describe('buildAmortization', () => {
    it('produces `term` rows and fully amortizes to a ~0 final balance', () => {
      const emi = calcEmi(10000, 12, 24);
      const rows = buildAmortization(10000, 12, 24, emi, new Date('2026-01-01'));
      expect(rows).toHaveLength(24);
      expect(rows[rows.length - 1].balance).toBe(0);
      // Sum of principal parts ≈ principal.
      const totalPrincipal = rows.reduce((s, r) => s + r.principalPart, 0);
      expect(totalPrincipal).toBeCloseTo(10000, 0);
      // Due dates step one month at a time from startDate.
      expect(rows[0].dueDate.getMonth()).toBe(1); // Feb (0-based)
    });
  });
});
