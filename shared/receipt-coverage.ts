// Насколько полно учтён бензин. Литры видит датчик, рубли знает только чек, и
// расходятся эти два счёта ровно на те заправки, чек с которых не доехал.
//
// Без этой доли сумма за месяц выглядит просто маленькой: «на бензин ушло шесть
// тысяч» — а половина бака в эти шесть тысяч не вошла, потому что заправлялись
// на трассе и чек остался в кармане. Величина эта не про машину, а про то,
// можно ли верить деньгам на соседней карточке.

export interface CoverageRefuel {
  litresAdded: number | null
  sensorLitresAdded: number | null
  totalAmount: number | null
}

export interface ReceiptCoverage {
  refuels: number
  covered: number
  missing: number
  litres: number
  litresCovered: number
  // Доля литров, за которыми стоит чек. Именно литров, а не заправок: долив на
  // пять литров без чека портит счёт куда меньше, чем полный бак.
  share: number | null
  amount: number
  // Во что обошлись заправки без чека, если считать их по цене тех, что с
  // чеком. Это оценка, а не сумма: настоящую знает только сам чек.
  missingAmount: number | null
  pricePerLitre: number | null
}

const volume = (refuel: CoverageRefuel) => refuel.litresAdded ?? refuel.sensorLitresAdded ?? null

export function summariseCoverage(refuels: CoverageRefuel[], fallbackPrice: number | null = null): ReceiptCoverage {
  const covered = refuels.filter(refuel => refuel.totalAmount != null)
  const amount = covered.reduce((sum, refuel) => sum + refuel.totalAmount!, 0)
  const litresCovered = covered.reduce((sum, refuel) => sum + (volume(refuel) ?? 0), 0)
  const litres = refuels.reduce((sum, refuel) => sum + (volume(refuel) ?? 0), 0)
  // Цена берётся по своим же оплаченным литрам, а если их нет — по той, что
  // передали снаружи: у месяца без единого чека собственной цены не бывает.
  const pricePerLitre = litresCovered > 0 && amount > 0 ? amount / litresCovered : fallbackPrice
  const litresMissing = Math.max(0, litres - litresCovered)

  return {
    refuels: refuels.length,
    covered: covered.length,
    missing: refuels.length - covered.length,
    litres,
    litresCovered,
    share: litres > 0 ? litresCovered / litres : null,
    amount,
    missingAmount: pricePerLitre != null && litresMissing > 0 ? litresMissing * pricePerLitre : null,
    pricePerLitre
  }
}
