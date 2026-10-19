// Keep free-text clinical and direct identifiers out of the external model.
// This is a conservative routing filter, not a substitute for privacy review.
const clinical = /\b(s[ií]ntomas?|diagn[oó]stic[oa]|enfermedad|dolores?|sangr\w*|embaraz\w*|medicaci[oó]n|medicamentos?|receta|anal[ií]tica|alergia|urgencia|emergencia|fiebre|lesi[oó]n|c[aá]ncer|diabetes|cirug[ií]a|operaci[oó]n|infecci[oó]n|tratamiento m[eé]dico|historial m[eé]dico)\b/i;
export function containsClinicalText(text: string) { return clinical.test(text); }

export function minimizeForModel(text: string) {
  if (containsClinicalText(text)) return "[consulta clínica omitida; derivar a una persona]";
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[correo omitido]")
    .replace(/(?:\+?\d[\s().-]*){9,15}/g, "[teléfono omitido]")
    .replace(/\b\d{8}[A-Z]\b/gi, "[documento omitido]")
    .replace(/\b(?:me llamo|mi nombre es)\s+[^,.!?\n]{2,50}/gi, "[nombre omitido]")
    .slice(0, 1200);
}
