/** 256 words → 8 bits each. Two words + 3-digit nameplate ≈ 24 bits. One guess at the mailbox. */
export const WORDS = [
  "able","acid","aged","also","area","army","away","baby","back","ball","band","bank","base","bath","bear","beat",
  "been","bell","best","bill","bird","blow","blue","boat","body","bomb","bond","bone","book","boom","born","both",
  "bowl","bulk","burn","bush","busy","call","calm","came","camp","card","care","case","cash","cast","cell","chat",
  "chip","city","clam","clay","clip","club","coal","coat","code","coil","cold","come","cook","cool","cope","copy",
  "core","corn","cost","crew","crop","dark","data","date","dawn","days","dead","deal","dean","dear","debt","deep",
  "deny","desk","dial","diet","disc","disk","does","done","door","dose","down","draw","drew","drop","drug","dual",
  "duck","dump","dust","duty","each","earn","ease","east","easy","edge","else","even","ever","evil","exit","face",
  "fact","fail","fair","fall","farm","fast","fate","fear","feed","feel","feet","fell","felt","file","fill","film",
  "find","fine","fire","firm","fish","five","flag","flat","flew","flow","foam","foil","fold","folk","food","foot",
  "ford","fork","form","fort","four","free","from","fuel","full","fund","gain","game","gate","gave","gear","gene",
  "gift","girl","give","glad","glow","goal","goes","gold","golf","gone","good","gray","grew","grid","grow","gulf",
  "hair","half","hall","hand","hang","hard","harm","hate","have","head","hear","heat","held","hell","help","here",
  "hero","hide","high","hill","hire","hold","hole","holy","home","hope","host","hour","huge","hung","hunt","hurt",
  "idea","inch","into","iron","item","jack","jane","jean","join","jump","jury","just","keen","keep","kent","kept",
  "kick","kill","kind","king","knee","knew","know","lack","lady","laid","lake","land","lane","last","late","lead",
  "left","less","life","lift","like","line","link","list","live","load","loan","lock","logo","long","look","loop",
] as const;

if (WORDS.length !== 256) {
  throw new Error(`wordlist must be 256, got ${WORDS.length}`);
}
