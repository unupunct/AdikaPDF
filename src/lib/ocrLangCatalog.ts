/**
 * Tesseract languages that can be downloaded for OCR: the LSTM "best_int"
 * data tesseract.js itself loads (the same files the app bundles), from the
 * npm packages `@tesseract.js-data/<code>@1.0.0` served by jsDelivr. Size and
 * SHA-256 of every file are pinned here (taken from jsDelivr's package
 * listing, which matches the bundled files byte for byte); a download that
 * differs is refused. kur and tgl have no LSTM data and are left out.
 */
export interface OcrLangInfo {
  code: string;
  name: string;
  size: number;
  sha256: string;
}

export const OCR_LANG_VERSION = '1.0.0';

export function ocrLangUrl(code: string): string {
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}@${OCR_LANG_VERSION}/4.0.0_best_int/${code}.traineddata.gz`;
}

// prettier-ignore
export const OCR_LANG_CATALOG: OcrLangInfo[] = [
  { code: "afr", name: "Afrikaans", size: 1834273, sha256: "a2a9ec1631e4d1a80f89518bd60c680464d3b87afa1483178859c1af19fdc9df" },
  { code: "amh", name: "Amharic", size: 2366946, sha256: "f1644849fd6afb587f7b2fea19b02a5c0a2a2f138cb04ff7cf0272ce66e28b80" },
  { code: "ara", name: "Arabic", size: 1661906, sha256: "f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639" },
  { code: "asm", name: "Assamese", size: 1469955, sha256: "d92c8b7cca44d3e19cf8aaac098eca74acb044a9d68ec614581afeb17c17aa20" },
  { code: "aze", name: "Azerbaijani", size: 1664212, sha256: "2652f2c25d74582f4dce0dec6fe6f9c4f0ce445c931642cc69db707af04de8a3" },
  { code: "aze_cyrl", name: "Azerbaijani - Cyrillic", size: 996769, sha256: "af2b210c3bcc12f3dd0d9ddf88ceb247717d4324467301433d5a4ae20beb805d" },
  { code: "bel", name: "Belarusian", size: 2106984, sha256: "642fd20eb04ae62b217800cb39d09bee030554ccee37751cc4e4edaaca51cac2" },
  { code: "ben", name: "Bengali", size: 1373429, sha256: "a7c1fd170b796d6b8d01b401d4bfcc54409f47b313a200e9e3756ce20d742725" },
  { code: "bod", name: "Tibetan", size: 1269959, sha256: "e43a8e96ff77d90c25bf401b5282bde758d9d1475d7017c8c6f7bfa4039adb1c" },
  { code: "bos", name: "Bosnian", size: 1155304, sha256: "3304de098dbdf006ebb365d4f5187686e8eb7e773899ac1d1d2d65a60462ec7c" },
  { code: "bul", name: "Bulgarian", size: 1411343, sha256: "a38fdba9367316dad1d595427a975756e8c31367fc94a6530d012827833db8d7" },
  { code: "cat", name: "Catalan; Valencian", size: 639438, sha256: "1003ea7490d8c88b9308ed5dead936910a662fc9a4222cd536b92a17178e41eb" },
  { code: "ceb", name: "Cebuano", size: 487818, sha256: "331aeeb921acc5d2e6b14f099c59bc1d7fe7fb3355f34ac0c730606319c5cca3" },
  { code: "ces", name: "Czech", size: 2225029, sha256: "1ea33a8b6f9a9c18a6aae44a71eda06bbfdc206fe53cf1fc8121fb74def99166" },
  { code: "chi_sim", name: "Chinese - Simplified", size: 1718768, sha256: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c" },
  { code: "chi_tra", name: "Chinese - Traditional", size: 1656239, sha256: "11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743" },
  { code: "chr", name: "Cherokee", size: 288203, sha256: "bdaabd80b88c141382b51e50463825d50afe02b5cd727412cf2a62e9af3fc36f" },
  { code: "cym", name: "Welsh", size: 1363985, sha256: "9aa1e5a953c3241b74f9894252de51637c5d1ba1a11c1cf772f6db7cff0ca935" },
  { code: "dan", name: "Danish", size: 1845116, sha256: "6af1a07c22894b728ebc75f0fd0c8519eca002cfab6da903eb4d62e24f163abc" },
  { code: "deu", name: "German", size: 1333102, sha256: "306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b" },
  { code: "dzo", name: "Dzongkha", size: 384320, sha256: "09fa9e9456821634a9fce435e31fd9bb9b102449d12b5b938c8ab12b855f415b" },
  { code: "ell", name: "Greek, Modern (1453-)", size: 1324749, sha256: "e8a293abb398ec479176c1575aef24e2bacb0611c713f3fa996f97f0cd996fb3" },
  { code: "eng", name: "English", size: 2952873, sha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91" },
  { code: "enm", name: "English, Middle (1100-1500)", size: 1991361, sha256: "fe43ca0328ded47ffb312f14a1659729a7947e919265571670137beb49f2f05b" },
  { code: "epo", name: "Esperanto", size: 2144471, sha256: "34e89c4f626c87fda7fe1769b748775b321869b2cbcb17944942a503b398f15c" },
  { code: "est", name: "Estonian", size: 3101722, sha256: "27a3ddb4ec40348c36277463285221c8638de4ac126e7da88af36837d2db9a4a" },
  { code: "eus", name: "Basque", size: 2240649, sha256: "e5a4ba32654272462f3a87965ae9812a98b787f4d437dd63914b85b1c2bf8ea7" },
  { code: "fas", name: "Persian", size: 424507, sha256: "b5847360e25f646c55449f1fe93eee57d53e406a265ead2374e7320bf0b82025" },
  { code: "fin", name: "Finnish", size: 3795323, sha256: "138c59f6a0bef68fd98d8baf565477f5cdb5198bfc4a68e558efd3b6a57acadd" },
  { code: "fra", name: "French", size: 707406, sha256: "d611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255" },
  { code: "frk", name: "German Fraktur", size: 3362304, sha256: "22186f9eae55cdc13846ea4d586f24f9fe64765c5400c41c2c46e55a8bb735be" },
  { code: "frm", name: "French, Middle (ca. 1400-1600)", size: 1000934, sha256: "8eedc2ae74b6b1af65f8e32b4300a86e69fc8c5cb601eb2348c79601998b3fcd" },
  { code: "gle", name: "Irish", size: 678843, sha256: "89a1eca11aff0e62280bdaa6c0344eb1de765b67058a7cbace95bf5b8b4b7be4" },
  { code: "glg", name: "Galician", size: 1743024, sha256: "950fe77dd9218d2bf642eeb423ab78fc2b3c7dab47c54cac6ccae2d1f81817f8" },
  { code: "grc", name: "Greek, Ancient (-1453)", size: 1091626, sha256: "5900b2bf126da1d98f3d5aabeea871f3e7386323ee6292be069bc7ed2b6a15cf" },
  { code: "guj", name: "Gujarati", size: 1219824, sha256: "f23bec3f02feca371fb37fe1733fca94881af376dc06ede6168ca54068f20efc" },
  { code: "hat", name: "Haitian; Haitian Creole", size: 1515839, sha256: "e8e31b94b546c840739d69e9066633cd336c939ad5ffdaf81acac5e40ff6a2e2" },
  { code: "heb", name: "Hebrew", size: 580576, sha256: "9c70b524200dae77fb25e3567566eee600ccbcae9aeb89722990ccae0e84e805" },
  { code: "hin", name: "Hindi", size: 1389692, sha256: "f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07" },
  { code: "hrv", name: "Croatian", size: 2290948, sha256: "3256cd52165cb82f5f136264daf68ee54320ee68fad6a4a9ddfd1bc1861f806a" },
  { code: "hun", name: "Hungarian", size: 2854466, sha256: "99feb1ac618ddd39942d646f1df792e5bd4504df45e1ef68e47df51db476a2ed" },
  { code: "iku", name: "Inuktitut", size: 1463630, sha256: "46c5076e11b759dbda26f561716531675cb12bb12a0182551829db87809d8081" },
  { code: "ind", name: "Indonesian", size: 1194182, sha256: "a8896d2f584a5baae73d658b86b765acc7b15b7ba05e014f62b1a2a23b699a91" },
  { code: "isl", name: "Icelandic", size: 1696807, sha256: "002a0b366f0e96c06a65896033b0aabb313c6cc4c6d9c9cca0969dee11ff1f56" },
  { code: "ita", name: "Italian", size: 1660998, sha256: "f702fcfad297ce028ede3626d1467b67939f23ff23595f9badd54681cf25a4d3" },
  { code: "ita_old", name: "Italian - Old", size: 1784533, sha256: "b7416567d680d1741128f3494ae3823fbc60efb1ab139b7494cdacffe97a6264" },
  { code: "jav", name: "Javanese", size: 1645119, sha256: "2a4f959dd02bc2013f958297c1c897b259f8c3b104659265d457c849b268a2bc" },
  { code: "jpn", name: "Japanese", size: 2030256, sha256: "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88" },
  { code: "kan", name: "Kannada", size: 1914250, sha256: "3ce2f873f3a8371e82a85c204fcfae1635e01b5796be26df0610e6916cb54cf0" },
  { code: "kat", name: "Georgian", size: 1088063, sha256: "74505e238b208fc30471654b9f694bda08e521cdc7c8a5e0846d1340ed585899" },
  { code: "kat_old", name: "Georgian - Old", size: 372117, sha256: "5bda0d0036fed781b0252a24b5ebbd137e9343e1671306c3946a762eaa1b2489" },
  { code: "kaz", name: "Kazakh", size: 2137822, sha256: "3c93708c240722194d473931c097e09f02510fe8b7593fa0c33ceb90ee87095a" },
  { code: "khm", name: "Central Khmer", size: 1064461, sha256: "f3aab6301b2570ee7cd6cd051094e1c4f075a0a7eeeb4ff111e7e67a9bc012c9" },
  { code: "kir", name: "Kirghiz; Kyrgyz", size: 4448704, sha256: "31c9579841744bc53dcf59392a63eb77e3ea648f67ef53106720c39d23281256" },
  { code: "kor", name: "Korean", size: 1572336, sha256: "78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126" },
  { code: "lao", name: "Lao", size: 3699720, sha256: "660306d4a42941426256c723a7d6d3b65f81e6c428e5f83d5f25180a486d0011" },
  { code: "lat", name: "Latin", size: 1739234, sha256: "22101c28f8f9b3e0b08a526a3e7895bb319d1e876684a150901c2e8580060e31" },
  { code: "lav", name: "Latvian", size: 1318441, sha256: "08bc2d5fd9c66a1893f2c4e131e3410321f4079e6d41810898706be49ae02a9c" },
  { code: "lit", name: "Lithuanian", size: 1901451, sha256: "b8dd9f13ee6570cd791b6e074176823f00fcf2c8102c0d37b665e7723933cd91" },
  { code: "mal", name: "Malayalam", size: 2794667, sha256: "a4a5b24474889dbbe9943bb3cb7b24819c1cd594f2f371340bba83c30fd81bf0" },
  { code: "mar", name: "Marathi", size: 1966154, sha256: "e4c20d649ab646e1d46da35f45d357eea25b7f28af4b0a7af3e205abaf6be788" },
  { code: "mkd", name: "Macedonian", size: 719182, sha256: "043ca096871a4b58bb1b3bca34c6793187e060a12f3d1384ab4e6d8d77e8b802" },
  { code: "mlt", name: "Maltese", size: 1164274, sha256: "756b8c1962b8d68dd5a3868b6106f49004d4f66b877c9c018c88a9a1d9ff07ac" },
  { code: "msa", name: "Malay", size: 1177136, sha256: "35ae490b99462d04cf4e2a7985d98f0ba5e10ca62adb13aeda070c6f1783f097" },
  { code: "mya", name: "Burmese", size: 2691297, sha256: "a6ac329fbc61a902c05bb10ec7a863e9983e3da65dc558fe1db909b61af67ce4" },
  { code: "nep", name: "Nepali", size: 1594252, sha256: "cda17f5f7c18a81167be44ce4f545d0b244f8b00912d55f6568ac08d0e0f3b0e" },
  { code: "nld", name: "Dutch; Flemish", size: 3005696, sha256: "a2d904b6ddc4feb0d31ecfcd7361a554102e7aa2e278c54f4fc029e0d0815571" },
  { code: "nor", name: "Norwegian", size: 2490241, sha256: "6c5d91a5b684da387bfcf16b38bae8d94771812dc9ef706b413c728ca1d37c93" },
  { code: "ori", name: "Oriya", size: 1058704, sha256: "b42f60e0460daf814952ed1b239723f9a4c4c694a29ab016d772a02c68ef5ddc" },
  { code: "pan", name: "Panjabi; Punjabi", size: 1396216, sha256: "10624ae040eb967316fcb1a1843421786a48542b22ef2fdd50afc00de58d27b5" },
  { code: "pol", name: "Polish", size: 2642356, sha256: "a20fdec4ff99d8f8e84c708da3e42a4e935c26863055a0ed88aef5c66a59b91b" },
  { code: "por", name: "Portuguese", size: 1392239, sha256: "dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c" },
  { code: "pus", name: "Pushto; Pashto", size: 1420364, sha256: "689b369c109107c4df1cd133446b9de0b10b79706a070d4c35dc885a52764105" },
  { code: "ron", name: "Romanian; Moldavian; Moldovan", size: 1692160, sha256: "3c2f550b6369f43254adf637cfe1088c7b6faff3d0382555219315112a24582a" },
  { code: "rus", name: "Russian", size: 2679598, sha256: "f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a" },
  { code: "san", name: "Sanskrit", size: 5707023, sha256: "f1ed7e622f015c9caba5c2843a06deee9343955e7d57a38d96aa79b43e154916" },
  { code: "sin", name: "Sinhala; Sinhalese", size: 1138317, sha256: "02d34b1f6565d26991fa25605c0bbddd3e39d9eefe471fce4b8a27fe9363ec94" },
  { code: "slk", name: "Slovak", size: 2377899, sha256: "839350509c06e498448e35ce9faf13e24b28150b2d5cc39b900a751c5009127f" },
  { code: "slv", name: "Slovenian", size: 1346857, sha256: "23550808c5ae045a2c6cabcb8a03a52239ffeaf45571d1120135ddc632d021f1" },
  { code: "spa", name: "Spanish; Castilian", size: 2100190, sha256: "40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb" },
  { code: "spa_old", name: "Spanish; Castilian - Old", size: 1651913, sha256: "9e4d121967b532a029e65bf628ffd57844ccdc0e09bbfcefd9cebd0b4409e9d4" },
  { code: "sqi", name: "Albanian", size: 962962, sha256: "a84023c64e1c0910f8fddc25d13f2dbe1157ce2f478abb48adc8013de9b108f1" },
  { code: "srp", name: "Serbian", size: 1537929, sha256: "4a864eba46de4a7c264fc3c34b63db6889218eb51eefc5d38c5eaac548d58c96" },
  { code: "srp_latn", name: "Serbian - Latin", size: 1774421, sha256: "db283bbbb4802a2f9c271bf00c15eec71c8a8cf045297f5b172a8dfcd3fbedd9" },
  { code: "swa", name: "Swahili", size: 1094930, sha256: "74c7bd51f173a3f174fbc8aaf8738819aa36000566857929ba6679ad5a2cf71f" },
  { code: "swe", name: "Swedish", size: 2503095, sha256: "b60d9fea7e570d11d6fdf26c8d0ef1d63b49222313773ce66777ed08fa20dc5a" },
  { code: "syr", name: "Syriac", size: 1607141, sha256: "2e739deb0522246785349f8ecf0bfe0b8d2b8f743c1c67d4b631b12fc8179eb4" },
  { code: "tam", name: "Tamil", size: 1446167, sha256: "2c4b255ede87931cb56c20a5b2b8e2cda4913e34fb3e4957f9b9e04ea069ff21" },
  { code: "tel", name: "Telugu", size: 1735518, sha256: "8b478895dfc1f5d6baee6f8e6cf84a873793dd8948124315437ff2dc38d49fe4" },
  { code: "tgk", name: "Tajik", size: 1164174, sha256: "660f8476c5635c93f83955f7bdce7c2c45bc685463a9c139b292c7f5853de0e9" },
  { code: "tha", name: "Thai", size: 896631, sha256: "4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74" },
  { code: "tir", name: "Tigrinya", size: 295477, sha256: "647f1d1e4f74262a253cce76ba835bb3be9d74b8268c9823cc794832b5ec8c1a" },
  { code: "tur", name: "Turkish", size: 2141291, sha256: "384ba0dc28040451b7818d7d60e0a88df0d3003fa5a01d713a468779bc3d8c04" },
  { code: "uig", name: "Uighur; Uyghur", size: 1850426, sha256: "3be33a65775f3dbfd72c0feb0b66a3f2198bb14378537ab770f583eb1f9fbad7" },
  { code: "ukr", name: "Ukrainian", size: 2114206, sha256: "ea2789a0ad99ff84bfd252a7410a1e8661a7bc5acaa41573d23b54b71446aa4c" },
  { code: "urd", name: "Urdu", size: 1023740, sha256: "9e1860440339543c935fca7cee2ce5ac742b1d1249c4ba5982385ce19d23096f" },
  { code: "uzb", name: "Uzbek", size: 3116151, sha256: "16d7f4a0af8722227ea447c99a2159f1a186af137c392ff8caeb69f2d4ceee20" },
  { code: "uzb_cyrl", name: "Uzbek - Cyrillic", size: 832890, sha256: "800d22c59b525b715015e1bf3aba49e98a0d6309305e245490f67698685f8842" },
  { code: "vie", name: "Vietnamese", size: 1423003, sha256: "2284f610f262a1b19ec8df9f196b9ff6ce38ddb4a66329e998941df4b8961c8d" },
  { code: "yid", name: "Yiddish", size: 445286, sha256: "90b3c603e53727a996a11bb6c9f9281cf893ed9275ceed4e0b27cbbc7c530de8" },
];
