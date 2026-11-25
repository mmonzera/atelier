/**
 * Query builder untuk selective memory: ubah teks bebas (prompt user, pesan pemicu, judul task)
 * menjadi daftar term pendek yang bisa dicari lewat FTS5 dengan semantik OR + prefix.
 */

const STOPWORDS = new Set(
  (
    // Indonesia
    'yang dan di ke dari ini itu aja saja dong deh nih sih kok lah kan tolong mohon bisa bisakah ' +
    'tidak nggak ngga gak enggak bukan belum sudah udah lagi masih akan mau ingin pengen buat bikin ' +
    'dengan untuk pada dalam oleh atau tapi tetapi karena jadi kalau kalo jika agar supaya sebagai ' +
    'saya aku kamu kita kami mereka dia anda gue gua lo lu ada adalah apa apakah siapa kapan dimana ' +
    'bagaimana gimana kenapa mengapa seperti lebih sangat banget juga hanya cuma sama semua setiap ' +
    'satu dua ok oke okay ya iya yup sip makasih terima kasih lanjut lanjutkan coba mari ayo dulu ' +
    'nanti sekarang tadi barusan lalu terus kemudian setelah sebelum ketika saat hal cara bagian ' +
    // English
    'the a an to of in on at for from by with and or but not no is are was were be been being do ' +
    'does did done have has had it its this that these those i you he she we they me my your our ' +
    'their him her them as if then than so just also please can could would should will shall may ' +
    'might must how what when where which who why let lets make get got use using about into out ' +
    'up down over under again more most some any all each very too ok okay yes yeah thanks thank ' +
    'continue go ahead now next one two'
  ).split(/\s+/),
);

/** Sinonim ID/EN yang sering muncul di brief desain. Hanya perluasan kecil agar BM25 tidak buta lintas bahasa. */
const SYNONYMS: Record<string, string[]> = {
  tombol: ['button'], button: ['tombol'],
  warna: ['color', 'colour'], color: ['warna'],
  halaman: ['page'], page: ['halaman'],
  judul: ['title', 'heading', 'headline'], title: ['judul'], headline: ['judul'],
  gambar: ['image', 'picture'], image: ['gambar'],
  tulisan: ['text', 'copy'], teks: ['text'], text: ['teks'],
  font: ['typography', 'huruf'], huruf: ['font'],
  ikon: ['icon'], icon: ['ikon'],
  keputusan: ['decision'], decision: ['keputusan'],
  aturan: ['rule'], rule: ['aturan'],
  tugas: ['task'], task: ['tugas'],
  bayangan: ['shadow'], shadow: ['bayangan'],
  sudut: ['radius', 'corner'], radius: ['sudut'],
  jarak: ['spacing', 'gap'], spacing: ['jarak'],
  masuk: ['login'], login: ['masuk'],
  harga: ['pricing', 'price'], pricing: ['harga'], price: ['harga'],
  footer: ['bawah'], hero: ['beranda'],
};

const TERM_RE = /[\p{L}\p{N}_][\p{L}\p{N}_./-]*/gu;

function isIdentifierLike(term: string): boolean {
  return /[./_-]/.test(term) || /\d/.test(term) || /^[a-z]{1,4}-\d+$/.test(term);
}

/** Term unik berurutan prioritas: path/identifier dulu, lalu kata biasa. */
export function extractTerms(text: string, max = 16): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const words: string[] = [];
  for (const raw of text.toLowerCase().match(TERM_RE) ?? []) {
    const term = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (!term || seen.has(term)) continue;
    const identifier = isIdentifierLike(term);
    if (!identifier && (term.length < 3 || STOPWORDS.has(term))) continue;
    if (/^\d+$/.test(term) && term.length < 3) continue;
    seen.add(term);
    (identifier ? ids : words).push(term);
  }
  return [...ids, ...words].slice(0, max);
}

export function expandSynonyms(terms: string[], max = 24): string[] {
  const out = [...terms];
  const seen = new Set(terms);
  for (const term of terms) {
    for (const syn of SYNONYMS[term] ?? []) {
      if (out.length >= max) return out;
      if (!seen.has(syn)) {
        seen.add(syn);
        out.push(syn);
      }
    }
  }
  return out;
}

function quoteTerm(term: string): string {
  return '"' + term.replaceAll('"', '') + '"';
}

/** `"a"* OR "b"* OR ...` — OR + prefix; BM25 yang mengurutkan. Kosong bila tidak ada term. */
export function buildFtsQuery(terms: string[], mode: 'or' | 'and' = 'or'): string {
  const parts = terms.map((t) => quoteTerm(t) + '*');
  return parts.join(mode === 'and' ? ' AND ' : ' OR ');
}
