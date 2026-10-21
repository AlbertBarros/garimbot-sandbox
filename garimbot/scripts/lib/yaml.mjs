// Leitor de YAML simples para os arquivos de config/ do Garimbot (sem
// dependências: a skill roda em qualquer pasta). Aceita o que usamos:
// mapas por indentação, listas com "- ", listas de mapas, texto entre aspas,
// números, true/false, null e comentários com "#".
const escalar = (t) => {
  const s = t.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^".*"$/.test(s)) return JSON.parse(s);
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^\[.*\]$/.test(s))
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(escalar);
  return s;
};
// tira o comentário de fim de linha (fora de aspas)
function semComentario(linha) {
  let aspas = null;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspas) {
      if (c === aspas) aspas = null;
    } else if (c === '"' || c === "'") aspas = c;
    else if (c === "#" && (i === 0 || /\s/.test(linha[i - 1])))
      return linha.slice(0, i);
  }
  return linha;
}
export function lerYaml(texto) {
  const linhas = String(texto)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => semComentario(l).replace(/\s+$/, ""))
    .map((l) => ({ ind: l.match(/^ */)[0].length, txt: l.trim() }))
    .filter((l) => l.txt);
  let i = 0;
  function bloco(ind) {
    if (i >= linhas.length) return null;
    if (linhas[i].txt.startsWith("- ") || linhas[i].txt === "-") {
      const lista = [];
      while (i < linhas.length && linhas[i].ind === ind && /^-( |$)/.test(linhas[i].txt)) {
        const resto = linhas[i].txt.slice(1).trim();
        const indItem = ind + 2;
        if (!resto) {
          i++;
          lista.push(bloco(linhas[i]?.ind ?? indItem));
        } else if (/^[^"'\s][^:]*:( |$)/.test(resto)) {
          // item que é um mapa: "- chave: valor" + linhas seguintes
          linhas[i] = { ind: indItem, txt: resto };
          lista.push(mapa(indItem));
        } else {
          lista.push(escalar(resto));
          i++;
        }
      }
      return lista;
    }
    return mapa(ind);
  }
  function mapa(ind) {
    const obj = {};
    while (i < linhas.length && linhas[i].ind === ind && !/^-( |$)/.test(linhas[i].txt)) {
      const m = /^([^:]+):(?: (.*))?$/.exec(linhas[i].txt);
      if (!m) throw new Error(`YAML inválido perto de: ${linhas[i].txt}`);
      const chave = m[1].trim().replace(/^["']|["']$/g, "");
      i++;
      if (m[2] !== undefined && m[2].trim() !== "") obj[chave] = escalar(m[2]);
      else if (i < linhas.length && linhas[i].ind > ind) obj[chave] = bloco(linhas[i].ind);
      else if (i < linhas.length && linhas[i].ind === ind && /^-( |$)/.test(linhas[i].txt))
        obj[chave] = bloco(ind);
      else obj[chave] = null;
    }
    return obj;
  }
  return linhas.length ? bloco(linhas[0].ind) : {};
}
