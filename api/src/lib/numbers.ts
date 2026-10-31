/**
 * Usuwa "szum" liczb zmiennoprzecinkowych 32-bitowych (Android wysyła Float): 2.4000000953674316 -> 2.4,
 * 6.1315422058105469 -> 6.13154. Zostawia 6 cyfr znaczących, więc małe wartości też są dokładne
 * (czas naświetlania 1/8000 s = 0.000125 zostaje 0.000125), a liczby całkowite się nie zmieniają.
 */
export function tidyNumber(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : n;
}

export function tidyNullable(n: number | null): number | null {
  return n === null ? null : tidyNumber(n);
}
