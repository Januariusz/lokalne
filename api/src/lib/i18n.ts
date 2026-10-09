import type { Context } from "hono";

export type Lang = "pl" | "en";

/** Język odpowiedzi: ?lang=pl|en ma pierwszeństwo, potem nagłówek Accept-Language; domyślnie angielski. */
export function langFromHeader(header: string | null | undefined): Lang {
  const first = (header ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("pl") ? "pl" : "en";
}

export function langOf(c: Context<any, any, any>): Lang {
  const q = c.req.query("lang")?.toLowerCase();
  if (q === "pl" || q === "en") return q;
  return langFromHeader(c.req.header("accept-language"));
}

/**
 * Polskie wersje komunikatów błędów API, klucz = stały kod błędu (`code`).
 * Wersja angielska jest w kodzie przy każdym fail(); {field} jest podmieniane nazwą pola.
 */
const PL: Record<string, string> = {
  UNAUTHORIZED:             "Wymagane zalogowanie",
  FORBIDDEN:                "Brak uprawnień",
  FORBIDDEN_ROLE_CHANGE:    "Ta zmiana roli nie jest dozwolona dla Twojej roli",
  NOT_FOUND:                "Nie znaleziono",
  INTERNAL_ERROR:           "Wewnętrzny błąd serwera",
  USER_BANNED:              "Twoje konto zostało zablokowane",
  USER_NOT_FOUND:           "Nie znaleziono użytkownika",
  CAMERA_NOT_FOUND:         "Nie znaleziono aparatu",
  SMARTPHONE_NOT_FOUND:     "Nie znaleziono telefonu",
  REVIEW_NOT_FOUND:         "Nie znaleziono recenzji",
  COMMENT_NOT_FOUND:        "Nie znaleziono komentarza",
  NOTIFICATION_NOT_FOUND:   "Nie znaleziono powiadomienia",
  OFFER_NOT_FOUND:          "Nie znaleziono propozycji awansu",
  BAN_NOT_FOUND:            "Użytkownik nie ma aktywnej blokady",
  INVALID_BODY:             "Treść żądania musi być poprawnym JSON-em",
  INVALID_FIELD:            "Nieprawidłowa wartość pola {field}",
  INVALID_FILTER:           "Nieprawidłowy filtr {field}",
  INVALID_SORT:             "Nieprawidłowe sortowanie",
  INVALID_ROLE:             "Nieprawidłowa rola",
  INVALID_STATUS:           "Nieprawidłowy status",
  STATUS_NOT_ALLOWED:       "Nie możesz ustawić tego statusu",
  MISSING_FIELDS:           "Brakuje wymaganych pól",
  NAME_REQUIRED:            "Nazwa jest wymagana",
  NOTHING_TO_UPDATE:        "Brak danych do aktualizacji",
  SMARTPHONE_ID_REQUIRED:   "Parametr smartphone_id jest wymagany",
  TOO_FEW_IDS:              "Podaj co najmniej 2 identyfikatory",
  TOO_MANY_IDS:             "Można porównać maksymalnie 4 telefony",
  MEDIA_ALREADY_DELETED:    "Ten plik został już usunięty",
  STORAGE_ERROR:            "Operacja na pliku nie powiodła się",
  UPLOAD_NOT_FOUND:         "Nie znaleziono wysłanego pliku",
  FILE_TOO_LARGE:           "Plik jest zbyt duży",
  FILE_REQUIRED:            "Wymagany jest plik",
  FIELDS_AFTER_FILE:        "Pola formularza muszą być wysłane przed plikiem",
  INVALID_CONTENT_TYPE:     "Oczekiwano formularza multipart/form-data",
  TOO_MANY_FILES:           "Można wysłać tylko jeden plik",
  FIELD_TOO_LONG:           "Wartość pola jest zbyt długa",
  UPLOAD_FAILED:            "Wysyłanie pliku nie powiodło się",
  INSUFFICIENT_SAMPLES:     "Aparat ze zmienną przysłoną lub zoomem wymaga zdjęć wykonanych przy co najmniej 2 różnych wartościach",
  NOT_ELIGIBLE:             "Ten użytkownik nie może zostać awansowany",
  PROMOTION_PENDING:        "Propozycja awansu dla tego użytkownika już czeka na odpowiedź",
  OFFER_ALREADY_ANSWERED:   "Na tę propozycję już odpowiedziano",
  ALREADY_BANNED:           "Użytkownik jest już zablokowany",
  CANNOT_BAN:               "Nie można zablokować tego użytkownika",
  REVIEW_NOT_PUBLISHED:     "Recenzja nie jest opublikowana",
  INVALID_SIGNATURE:        "Nieprawidłowy lub wygasły link do pliku",
  PASSWORD_REQUIRED:        "Hasło jest wymagane",
  PASSWORD_TOO_WEAK:        "Hasło musi mieć co najmniej 8 znaków oraz zawierać małą literę, wielką literę, cyfrę i znak specjalny",
  // better-auth
  INVALID_EMAIL_OR_PASSWORD: "Nieprawidłowy e-mail lub hasło",
  INVALID_PASSWORD:          "Nieprawidłowe hasło",
  INVALID_EMAIL:             "Nieprawidłowy adres e-mail",
  INVALID_TOKEN:             "Nieprawidłowy lub wygasły token",
  EMAIL_NOT_VERIFIED:        "Adres e-mail nie został potwierdzony",
  USER_ALREADY_EXISTS:       "Użytkownik z tym adresem e-mail już istnieje",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Użytkownik z tym adresem e-mail już istnieje",
  PASSWORD_TOO_SHORT:        "Hasło jest zbyt krótkie",
  PASSWORD_TOO_LONG:         "Hasło jest zbyt długie",
  FAILED_TO_CREATE_USER:     "Nie udało się utworzyć konta",
  FAILED_TO_CREATE_SESSION:  "Nie udało się utworzyć sesji",
  SESSION_EXPIRED:           "Sesja wygasła",
  USER_EMAIL_NOT_FOUND:      "Nie znaleziono użytkownika o tym adresie e-mail",
  EMAIL_ALREADY_VERIFIED:    "Adres e-mail jest już potwierdzony",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Nie znaleziono konta z hasłem",
  CHANGE_EMAIL_DISABLED:     "Zmiana adresu e-mail jest wyłączona",
  EMAIL_CANNOT_BE_CHANGED:   "Nie można zmienić adresu e-mail",
};

/** Zwraca komunikat w żądanym języku; dla angielskiego (lub braku tłumaczenia) oryginał. */
export function localize(
  lang: Lang, code: string, fallback: string, extra?: Record<string, unknown>,
): string {
  if (lang !== "pl") return fallback;
  const tpl = PL[code];
  if (!tpl) return fallback;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(extra?.[k] ?? ""));
}
