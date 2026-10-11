import { validateCatalog } from "../src/domain/catalogs";
import english from "../src/i18n/en.json";
import german from "../src/i18n/de.json";
validateCatalog(english, english);
validateCatalog(english, german);
console.log("English/German keys and ICU messages validated.");
