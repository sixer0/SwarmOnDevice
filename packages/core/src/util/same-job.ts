// Whether two pieces of text ask for the same kind of job. Word overlap and nothing more: it runs on every finished run
// and every draft, costs no tokens, and when it misses, the user simply sees nothing.

const FILLER = new Set(
  // English, then Indonesian. Verbs like "fix" and "update" stay: they are most of what a job is.
  "a an and are as at be but by can could do does for from get go has have how i if in into is it its just let me my need needs of on or our out over please should so some that the their them then there these this those to too up us use using was we were what when where which will with would you your yang dan di ke dari untuk tolong ini itu dengan pada saya kita bisa harus agar supaya atau juga lalu".split(
    " ",
  ),
)

/** Long pasted logs say nothing about the job and would swamp the words that do. */
const ASK_LENGTH = 400

function stem(word: string) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y"
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

export function jobWords(text: string) {
  const words = Array.from(text.slice(0, ASK_LENGTH).toLowerCase().matchAll(/\p{L}[\p{L}\p{N}]+/gu), (m) => m[0])
  return [...new Set(words.filter((word) => !FILLER.has(word)).map(stem))]
}

/** Both are asks of about the same size and most of their words are shared. */
export function sameJob(a: string, b: string) {
  const left = jobWords(a)
  const right = new Set(jobWords(b))
  const shared = left.filter((word) => right.has(word)).length
  if (shared < 2) return false
  return (2 * shared) / (left.length + right.size) >= 0.5
}

/** The ask covers most of a short label such as a command's name and description. The ask may say much more. */
export function jobMatchesLabel(ask: string, label: string) {
  const asked = new Set(jobWords(ask))
  const words = jobWords(label)
  const shared = words.filter((word) => asked.has(word)).length
  return shared >= 2 && shared / words.length >= 0.6
}
