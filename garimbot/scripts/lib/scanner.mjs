// Scanner estático do Garimbot (seção 5.3): lê os arquivos do repositório
// clonado SEM executar nada e devolve achados. Todo texto do repositório é
// DADO, nunca instrução. Dois níveis:
//  - "bloqueio": reprova direto (padrão claramente perigoso);
//  - "revisar": vai para os dois revisores; qualquer dúvida deles reprova.
// Os dois níveis são achados de segurança: um repositório só é APROVADO sem
// nenhum "bloqueio" e com os dois revisores aprovando todos os "revisar".
import { readdir, readFile, lstat, readlink, open } from "node:fs/promises";
import path from "node:path";

export const LIMITES = { arquivoTexto: 5 * 1024 * 1024, trecho: 400, arquivosIa: 6000 };
// arquivos de instrução para IA: sempre vão inteiros (até o limite) para os revisores
export const ARQUIVOS_IA = [
  /(^|\/)CLAUDE\.md$/i, /(^|\/)AGENTS\.md$/i, /(^|\/)GEMINI\.md$/i, /(^|\/)\.cursorrules$/i,
  /(^|\/)\.windsurfrules$/i, /(^|\/)\.cursor\/rules\//i, /(^|\/)\.github\/copilot-instructions\.md$/i,
  /(^|\/)\.claude\//i, /(^|\/)\.mcp\.json$/i, /(^|\/)\.clinerules/i, /(^|\/)\.github\/instructions\//i,
];
export const ehArquivoIa = (rel) => ARQUIVOS_IA.some((r) => r.test(rel));
const EXEC_EXT = /\.(exe|dll|so|dylib|node|bin|msi|apk|app|scr|com|class|jar|pyc|pyo|pkl|pickle|pt|pth|ckpt|joblib)$/i;
const MINIFICADO = /(\.min\.(js|css)$|(^|\/)(dist|build|vendor|vendors|third_party|public\/assets)\/|\.map$|\.lock$|lock\.json$|\.snap$|\.svg$)/i;
const CODIGO = /\.(m?[jt]sx?|cjs|py|rb|php|go|rs|java|kt|cs|ps1|psm1|sh|bash|zsh|bat|cmd|lua|pl|swift)$/i;
const DOC = /\.(md|mdx|markdown|txt|rst|html?|adoc)$/i;
const SCRIPT_SHELL = /\.(sh|bash|zsh|ps1|psm1|bat|cmd)$|(^|\/)Makefile$/i;

// Unicode invisível e bidirecional (Trojan Source e instruções escondidas)
export const BIDI = /[‪-‮⁦-⁩]/u;
export const TAGS = /[\u{E0000}-\u{E007F}]/u;
export const INVISIVEIS = /[​‌⁠-⁤᠎]|(?<!^)﻿/u;
// frases de quem tenta dar ordens a uma IA (português e inglês)
export const INJECAO = new RegExp(
  [
    "ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages)",
    "disregard (all |the )?(previous|prior|above) (instructions|rules)",
    "ignore (as|todas as) instru[cç][oõ]es (anteriores|acima)",
    "esque[cç]a (as|todas as) instru[cç][oõ]es",
    "you are now (?:a|an|in) ",
    "(new|updated) system prompt",
    "do not (tell|inform|show|mention) (this to )?the user",
    "n[aã]o (conte|mostre|avise|diga) (isso )?(ao|para o) usu[aá]rio",
    "(run|execute) (this|the following) (command|script) (silently|without asking)",
    "rode (este|o seguinte) comando",
    "add (this|the following) (mcp|server) to",
    "adicione (este|o seguinte) (mcp|servidor)",
    "(assistant|claude|ai|agent)s?,? (you must|please) (now )?(ignore|run|execute|install|send)",
    "<\\s*/?\\s*(system|instructions?)\\s*>",
  ].join("|"),
  "i",
);
const BAIXA_E_RODA = /(curl|wget)\b[^\n|;]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,200}\|\s*(iex|Invoke-Expression)\b/i;
const PS_CODIFICADO = /powershell(\.exe)?\s+[^\n]{0,40}-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i;
const SEGREDOS = [
  [/AKIA[0-9A-Z]{16}/, "chave da AWS"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "token do GitHub"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "chave da Anthropic"],
  [/sk-[A-Za-z0-9]{40,}/, "chave de API (sk-)"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "token do Slack"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "chave privada"],
  [/AIza[0-9A-Za-z_-]{35}/, "chave do Google"],
];
const DESTINOS = [
  [/discord(app)?\.com\/api\/webhooks\//i, "webhook do Discord (saída de dados)", "bloqueio"],
  [/api\.telegram\.org\/bot/i, "bot do Telegram (saída de dados)", "bloqueio"],
  [/pastebin\.com\/raw|paste\.ee\/r\/|hastebin\.com\/raw/i, "código baixado de site de colar texto", "bloqueio"],
  [/\b[a-z0-9-]+\.ngrok(-free)?\.(io|app)\b|transfer\.sh\/|\bfile\.io\//i, "túnel ou envio de arquivo temporário", "bloqueio"],
  [/https?:\/\/(?!(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|localhost))\d{1,3}(\.\d{1,3}){3}(:\d+)?\//, "endereço IP fixo na internet", "revisar"],
];
const SENSIVEIS = [
  [/\.ssh\/(id_(rsa|ed25519|ecdsa|dsa)|authorized_keys)|\bid_rsa\b/i, "leitura de chaves SSH"],
  [/Login Data|Local State|cookies\.sqlite|key4\.db|logins\.json/, "credenciais de navegador"],
  [/wallet\.dat|\bExodus\b.{0,40}wallet|Electrum.{0,40}wallets|\.ethereum\/keystore/i, "carteira de criptomoeda"],
  [/discord[^\n]{0,60}(Local Storage|leveldb)/i, "roubo de token do Discord"],
];
const DINAMICO = [
  [/\beval\s*\(/, "eval"],
  [/\bnew Function\s*\(/, "new Function"],
  [/child_process|\bexecSync\s*\(|\bspawnSync\s*\(/, "child_process"],
  [/\bos\.system\s*\(|subprocess\.(Popen|call|run|check_output)\([^\n)]*shell\s*=\s*True/, "comando do sistema (Python)"],
  [/Invoke-Expression|\biex\s*\(/i, "Invoke-Expression"],
  [/Runtime\.getRuntime\(\)\.exec/, "exec (Java)"],
  [/(?:require|import)\s*\(\s*["']https?:\/\//, "código importado de URL"],
  [/\b(clipboardy|pbpaste|Get-Clipboard|navigator\.clipboard\.readText)\b/, "leitura da área de transferência"],
  [/\b(posthog|mixpanel|amplitude|segment\.(io|com)|telemetry)\b/i, "telemetria"],
  [/auto-?updater|self[-_]update|checkForUpdates/i, "atualização automática"],
];
const OFUSCADO = /(_0x[0-9a-f]{4,}[^\n]*){5,}/i;
const HEX_LONGO = /(\\x[0-9a-f]{2}){40,}/i;
const BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{300,}={0,2}(?![A-Za-z0-9+/=])/;

const mostra = (s, max = LIMITES.trecho) =>
  String(s)
    .slice(0, max)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]|[\u{E0000}-\u{E007F}]/gu, (c) =>
      "\\u{" + c.codePointAt(0).toString(16) + "}",
    );
const linhaDe = (texto, idx) => texto.slice(0, idx).split("\n").length;

async function* arquivos(raiz, rel = "") {
  for (const e of await readdir(path.join(raiz, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (r === ".git") continue;
    if (e.isDirectory()) yield* arquivos(raiz, r);
    else yield { rel: r, ent: e };
  }
}
async function cabeca(arquivo, n = 8192) {
  const fh = await open(arquivo, "r");
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
const ehBinario = (buf) => buf.includes(0);
const MAGICOS = [
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "executável Linux (ELF)"],
  [Buffer.from([0x4d, 0x5a]), "executável Windows (MZ)"],
  [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), "executável macOS"],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), "executável macOS/Java"],
];

export async function escanear(raiz) {
  const achados = [];
  const ia = [];
  const pacoteRevisao = []; // trechos de risco (scripts de instalação, workflows…)
  let total = 0;
  const add = (nivel, regra, rel, detalhe, linha = null) =>
    achados.push({ nivel, regra, arquivo: rel, linha, detalhe: mostra(detalhe) });
  for await (const { rel, ent } of arquivos(raiz)) {
    total++;
    const abs = path.join(raiz, rel);
    if (ent.isSymbolicLink()) {
      const alvo = await readlink(abs).catch(() => "");
      const fim = path.resolve(path.dirname(abs), alvo);
      if (!fim.startsWith(path.resolve(raiz) + path.sep))
        add("bloqueio", "link-para-fora", rel, `link simbólico aponta para fora: ${alvo}`);
      continue;
    }
    const st = await lstat(abs);
    const cab = st.size ? await cabeca(abs) : Buffer.alloc(0);
    const magico = MAGICOS.find(([m]) => cab.subarray(0, m.length).equals(m));
    if (magico || EXEC_EXT.test(rel)) {
      const wrapper = /(^|\/)gradle\/wrapper\/gradle-wrapper\.jar$/.test(rel);
      add(wrapper ? "revisar" : "bloqueio", "binario", rel, magico ? magico[1] : "arquivo executável ou que executa código ao carregar");
      continue;
    }
    if (ehBinario(cab)) continue; // imagem, fonte etc.
    if (st.size > LIMITES.arquivoTexto) {
      add("bloqueio", "nao-analisado", rel, `arquivo de texto grande demais para analisar (${Math.round(st.size / 1e6)} MB)`);
      continue;
    }
    const texto = await readFile(abs, "utf8");
    const arquivoIa = ehArquivoIa(rel);
    if (arquivoIa) ia.push({ arquivo: rel, conteudo: mostra(texto, LIMITES.arquivosIa) });
    // Unicode escondido
    for (const [re, nome, nivel] of [
      [BIDI, "caracteres bidirecionais (Trojan Source)", "bloqueio"],
      [TAGS, "caracteres Unicode invisíveis (tags)", "bloqueio"],
      [INVISIVEIS, "caracteres invisíveis", arquivoIa || DOC.test(rel) ? "bloqueio" : "revisar"],
    ]) {
      const m = re.exec(texto);
      if (m) add(nivel, "unicode-escondido", rel, nome + ": " + texto.slice(Math.max(0, m.index - 60), m.index + 60), linhaDe(texto, m.index));
    }
    // injeção de prompt (em arquivos de IA, documentação e comentários HTML é bloqueio)
    const inj = INJECAO.exec(texto);
    if (inj)
      add(arquivoIa || DOC.test(rel) ? "bloqueio" : "revisar", "injecao-de-prompt", rel, texto.slice(Math.max(0, inj.index - 80), inj.index + 160), linhaDe(texto, inj.index));
    if (DOC.test(rel))
      for (const m of texto.matchAll(/<!--([\s\S]*?)-->/g))
        if (/\b(ignore|ignor[ea]|instru|assistant|claude|agent|run|execute|rode|execute|install|instale|mcp|prompt)\b/i.test(m[1]))
          add("bloqueio", "comentario-escondido", rel, "comentário HTML com ordens: " + m[1], linhaDe(texto, m.index));
    // baixar e executar
    for (const [re, nome] of [[BAIXA_E_RODA, "baixa da internet e executa"], [PS_CODIFICADO, "PowerShell codificado"]]) {
      const m = re.exec(texto);
      if (m)
        add(
          SCRIPT_SHELL.test(rel) || /package\.json$/.test(rel) || nome === "PowerShell codificado" ? "bloqueio" : "revisar",
          "baixa-e-executa",
          rel,
          nome + ": " + m[0],
          linhaDe(texto, m.index),
        );
    }
    for (const [re, nome] of SEGREDOS) {
      const m = re.exec(texto);
      if (m) add("bloqueio", "segredo", rel, nome + " no arquivo (valor oculto)", linhaDe(texto, m.index));
    }
    for (const [re, nome, nivel] of DESTINOS) {
      const m = re.exec(texto);
      if (m && (CODIGO.test(rel) || arquivoIa || /\.json$/.test(rel)))
        add(nivel, "destino-suspeito", rel, nome + ": " + m[0], linhaDe(texto, m.index));
    }
    if (CODIGO.test(rel) || arquivoIa) {
      for (const [re, nome] of SENSIVEIS) {
        const m = re.exec(texto);
        if (m) add("bloqueio", "dados-sensiveis", rel, nome + ": " + texto.slice(Math.max(0, m.index - 60), m.index + 80), linhaDe(texto, m.index));
      }
    }
    if (CODIGO.test(rel) && !MINIFICADO.test(rel)) {
      for (const [re, nome] of DINAMICO) {
        const m = re.exec(texto);
        if (m) add("revisar", "execucao-dinamica", rel, nome + ": " + texto.slice(Math.max(0, m.index - 80), m.index + 120), linhaDe(texto, m.index));
      }
      if (OFUSCADO.test(texto)) add("bloqueio", "ofuscacao", rel, "código ofuscado (_0x…)");
      const hx = HEX_LONGO.exec(texto);
      if (hx) add("revisar", "ofuscacao", rel, "sequência longa de \\x..: " + hx[0].slice(0, 80), linhaDe(texto, hx.index));
      const longa = texto.split("\n").findIndex((l) => l.length > 3000);
      if (longa >= 0) add("revisar", "ofuscacao", rel, "linha com mais de 3000 caracteres", longa + 1);
    }
    if (CODIGO.test(rel) || DOC.test(rel) || arquivoIa) {
      const b = BASE64.exec(texto);
      if (b && !/data:(image|font)\//.test(texto.slice(Math.max(0, b.index - 40), b.index))) {
        let dec = "";
        try {
          dec = Buffer.from(b[0], "base64").toString("utf8");
        } catch {}
        const perigoso = /https?:|eval|exec|child_process|powershell|\/bin\/sh|ignore (previous|all)/i.test(dec);
        add(perigoso ? "bloqueio" : "revisar", "base64", rel, (perigoso ? "texto em base64 que vira código/endereço: " : "bloco base64 longo: ") + dec.slice(0, 120), linhaDe(texto, b.index));
      }
    }
    // execução automática ao instalar/abrir
    if (/(^|\/)package\.json$/.test(rel) && !/node_modules\//.test(rel)) {
      let pj = null;
      try {
        pj = JSON.parse(texto);
      } catch {
        add("bloqueio", "nao-analisado", rel, "package.json ilegível");
      }
      if (pj) {
        for (const s of ["preinstall", "install", "postinstall", "preuninstall", "postuninstall", "prepublish"])
          if (pj.scripts?.[s]) add("bloqueio", "instalacao-automatica", rel, `script "${s}": ${pj.scripts[s]}`);
        if (pj.scripts?.prepare) {
          add("revisar", "instalacao-automatica", rel, `script "prepare": ${pj.scripts.prepare}`);
          pacoteRevisao.push({ arquivo: rel, motivo: "script prepare", conteudo: mostra(JSON.stringify(pj.scripts, null, 2), 4000) });
        }
        for (const grupo of ["dependencies", "devDependencies", "optionalDependencies"])
          for (const [n, v] of Object.entries(pj[grupo] ?? {}))
            if (/^(https?:|git(\+|:)|github:|file:|link:)|\.tgz$/.test(String(v)))
              add("bloqueio", "dependencia-de-url", rel, `${n} vem de ${v}`);
      }
    }
    if (/(^|\/)setup\.py$/.test(rel)) {
      if (/cmdclass|os\.system|subprocess|urllib|requests\.|socket\./.test(texto))
        add("revisar", "instalacao-automatica", rel, "setup.py com comando, rede ou classe de instalação própria");
      pacoteRevisao.push({ arquivo: rel, motivo: "setup.py", conteudo: mostra(texto, 4000) });
    }
    if (/(^|\/)\.vscode\/tasks\.json$/.test(rel) && /"runOn"\s*:\s*"folderOpen"/.test(texto))
      add("bloqueio", "abre-e-executa", rel, "tarefa do VS Code roda sozinha ao abrir a pasta");
    if (/(^|\/)\.devcontainer\//.test(rel) && /"(initializeCommand)"/.test(texto))
      add("bloqueio", "abre-e-executa", rel, "devcontainer roda comando no computador ao abrir");
    else if (/(^|\/)\.devcontainer\//.test(rel) && /"(postCreateCommand|postStartCommand|onCreateCommand|postAttachCommand)"/.test(texto))
      add("revisar", "abre-e-executa", rel, "devcontainer roda comando ao criar/iniciar");
    if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(rel) && /"hooks"\s*:/.test(texto))
      add("bloqueio", "hooks-de-ia", rel, "configuração do Claude com hooks (executa comandos)");
    if (/(^|\/)\.mcp\.json$/.test(rel)) add("revisar", "mcp", rel, "configuração de servidor MCP no repositório");
    if (/(^|\/)\.gitmodules$/.test(rel)) add("revisar", "submodulo", rel, "submódulos: código de outro repositório não auditado");
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) {
      pacoteRevisao.push({ arquivo: rel, motivo: "workflow do GitHub Actions", conteudo: mostra(texto, 4000) });
      if (/pull_request_target/.test(texto))
        add(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(texto) ? "bloqueio" : "revisar", "workflow-perigoso", rel, "pull_request_target");
      for (const m of texto.matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([\w.-]+)/g)) {
        const [, acao, versao] = m;
        if (!/^(actions|github)\//.test(acao) && !/^[0-9a-f]{40}$/.test(versao))
          add("bloqueio", "workflow-perigoso", rel, `action de terceiro sem versão fixa (SHA): ${acao}@${versao}`, linhaDe(texto, m.index));
      }
    }
    if (SCRIPT_SHELL.test(rel) && /\b(curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i.test(texto))
      pacoteRevisao.push({ arquivo: rel, motivo: "script que baixa da internet", conteudo: mostra(texto, 4000) });
  }
  return { arquivos: total, achados, arquivos_ia: ia, revisar_trechos: pacoteRevisao };
}
