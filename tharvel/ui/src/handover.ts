// Messaggio di consegna delle credenziali al cliente.
//
// Vive qui e non nei componenti perché lo producono due punti diversi: il wizard a
// fine onboarding (AddSiteWizard) e il pannello "Chiavi di accesso" quando l'admin le
// recupera dopo (AccessKeysModal). Duplicarlo significherebbe che a un certo punto le
// due versioni divergono e il cliente riceve due testi diversi.

export interface HandoverFields {
  adminUrl: string;
  email: string;
  // null quando la password non è recuperabile: il messaggio lo dice esplicitamente
  // invece di stampare un campo vuoto che sembrerebbe un bug.
  password: string | null;
}

export function buildHandoverMessage({ adminUrl, email, password }: HandoverFields): string {
  return `Ciao,

Il tuo pannello Tharvel è pronto:

URL:      ${adminUrl}
Email:    ${email}
Password: ${password ?? '(da rigenerare)'}

Da lì puoi chiedere le modifiche al sito via chat e pubblicarle quando sei pronto.

Buon lavoro!`;
}
