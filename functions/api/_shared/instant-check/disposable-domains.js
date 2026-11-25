// Well-known disposable / throwaway email providers. Matched on the address's
// domain and every parent domain (email.js), so subdomains of these are
// caught too. Not exhaustive by design: it raises the cost of burning the
// daily budget with fresh inboxes, and the rate limits do the rest. Free
// webmail (gmail.com, outlook.com, yahoo.com, …) is deliberately NOT here.

export const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "10minutemail.co.uk", "10minutemail.de", "10minemail.com",
  "20minutemail.com", "20minutemail.it", "33mail.com", "anonbox.net", "anonymbox.com",
  "binkmail.com", "bobmail.info", "burnermail.io", "chacuo.net", "cool.fr.nf",
  "courriel.fr.nf", "crazymailing.com", "cuvox.de", "dayrep.com", "deadaddress.com",
  "despam.it", "devnullmail.com", "discard.email", "discardmail.com", "discardmail.de",
  "dispostable.com", "dodgit.com", "dropmail.me", "dumpmail.de", "e4ward.com",
  "einrot.com", "email-fake.com", "emailfake.com", "emailondeck.com", "emailtemporanea.net",
  "emailtemporario.com.br", "emailsensei.com", "emltmp.com", "fakeinbox.com", "fakemail.net",
  "fakemailgenerator.com", "fastacura.com", "filzmail.com", "fleckens.hu", "getairmail.com",
  "getnada.com", "nada.email", "gishpuppy.com", "grr.la", "guerrillamail.biz",
  "guerrillamail.com", "guerrillamail.de", "guerrillamail.info", "guerrillamail.net", "guerrillamail.org",
  "guerrillamailblock.com", "gustr.com", "harakirimail.com", "hmamail.com", "hulapla.de",
  "ieatspam.eu", "ieatspam.info", "imgof.com", "incognitomail.com", "inboxbear.com",
  "inboxkitten.com", "jetable.org", "jourrapide.com", "kasmail.com", "killmail.net",
  "klzlk.com", "koszmail.pl", "kurzepost.de", "letthemeatspam.com", "lroid.com",
  "mail-temp.com", "mail.tm", "mail7.io", "mailcatch.com", "maildrop.cc",
  "mailexpire.com", "mailforspam.com", "mailfreeonline.com", "mailinator.com", "mailinator.net",
  "mailinator.org", "mailinator2.com", "mailnesia.com", "mailnull.com", "mailpoof.com",
  "mailsac.com", "mailslurp.com", "mailtemp.info", "meltmail.com", "mintemail.com",
  "moakt.com", "mohmal.com", "mt2015.com", "mytemp.email", "mytrashmail.com",
  "no-spam.ws", "nowmymail.com", "nwytg.net", "objectmail.com", "one-time.email",
  "oneoffemail.com", "owlymail.com", "pokemail.net", "proxymail.eu", "rcpt.at",
  "rhyta.com", "rmqkr.net", "safetymail.info", "sharklasers.com", "shieldemail.com",
  "slipry.net", "sneakemail.com", "sogetthis.com", "spam4.me", "spambog.com",
  "spambox.us", "spamgourmet.com", "spamhole.com", "spaml.com", "spammotel.com",
  "spamex.com", "spamfree24.org", "superrito.com", "suremail.info", "teleworm.us",
  "temp-mail.io", "temp-mail.org", "temp-mail.ru", "tempail.com", "tempemail.net",
  "tempinbox.com", "tempmail.com", "tempmail.de", "tempmail.dev", "tempmail.net",
  "tempmail.plus", "tempmail.us.com", "tempmailaddress.com", "tempmailo.com", "tempmails.net",
  "tempr.email", "temporarymail.com", "throwam.com", "throwawaymail.com", "tmail.ws",
  "tmailinator.com", "tmpmail.net", "tmpmail.org", "trash-mail.com", "trash2009.com",
  "trashmail.at", "trashmail.com", "trashmail.de", "trashmail.io", "trashmail.me",
  "trashmail.net", "trashmailer.com", "trbvm.com", "veryrealemail.com", "wegwerfmail.de",
  "wegwerfmail.net", "wegwerfemail.de", "yopmail.com", "yopmail.fr", "yopmail.net",
  "zetmail.com", "zippymail.info", "zoemail.org",
]);

// Families that rotate through many TLDs (tempmail.xyz, guerrillamail.lol …):
// matched against every label of the address's domain except the TLD.
export const DISPOSABLE_LABELS = new Set([
  "10minutemail", "guerrillamail", "mailinator", "tempmail", "temp-mail", "trashmail", "yopmail",
  "throwawaymail", "fakeinbox", "discardmail",
]);
