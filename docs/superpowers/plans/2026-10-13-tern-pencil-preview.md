# tern-pencil-preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin Tern que mostra designs `.pen` num block nativo (imagem por frame, layers, inspetor), atualizando ao vivo pelo MCP do app Pencil ou pelo `pen` CLI headless.

**Architecture:** Metade host define o block `pencil-preview.preview`; um tick por vez roda o snippet `refresh` (resumo + Export) pelo MCP do app (arquivo aberto no Pencil) ou pelo `pen interactive` headless (arquivo no disco), lê o PNG e envia como blob. Metade window roteia aberturas de `.pen` e registra comandos. Módulos puros em `lib/` testados com `luau`.

**Tech Stack:** Luau (Tern 0.8.3 plugin API, `--!strict`), `luau` 0.742 CLI para testes, `luau-analyze` + `tern.d.luau` para tipos, pen CLI 0.3.9, servidor MCP do app Pen.

**Spec:** `docs/superpowers/specs/2026-10-13-tern-pencil-preview-design.md`

## Global Constraints

- Plugin id `pencil-preview`; block id `preview` (kind `pencil-preview.preview`); nome "Pencil Preview"; ícone `pen`.
- Todo processo via `tern.process.run` com callback e `timeout_ms`; nunca bloquear; host tem 2 s por chamada.
- O arquivo `.pen` do usuário nunca é escrito pelo plugin.
- PNG enviado nunca passa de 4096 px por lado (escala calculada no snippet).
- Overrides: `TERN_PENCIL_CLI`, `TERN_PENCIL_MCP`, `TERN_PENCIL_APP`.
- Agent name no MCP: `tern-pencil-preview`.
- Ferramentas: `D:\tools\luau\luau.exe`, `D:\tools\luau\luau-analyze.exe` (fora do repo).

## File Structure

| Arquivo | Responsabilidade |
| --- | --- |
| `plugin.toml` | Manifesto |
| `host.luau` | Block: estado, ciclo, teclas, eventos, save |
| `window.luau` | Rota `.pen`, interruptor, comando "preview do documento aberto no Pencil" |
| `lib/script.luau` | Snippets JS (`refresh`, `update`) e `js_string` |
| `lib/doc.luau` | `find_summary`, `parse` → `Summary` |
| `lib/mcp.luau` | `request`, `parse`, `active_document` |
| `lib/launch.luau` | `pen_cli`, `mcp_server`, `pen_app` |
| `lib/view.luau` | Views puras |
| `tests/run.luau`, `tests/stub.luau`, `tests/*_test.luau` | Runner, stub de `tern`, testes |
| `tests/fixtures/sample.pen`, `tests/fixtures/sample.summary.txt` | Fixture e saída real do snippet |

---

### Task 1: Runner de testes e stub de `tern`

**Files:** Create `tests/run.luau`, `tests/stub.luau`.

**Interfaces:** Produces `stub.install(opts: {os: string?, env: {[string]: string}?, files: {[string]: boolean}?})` que define o global `tern` com `json.encode/decode` (implementação Luau mínima, só para testes), `fs.exists`, `getenv`, `runtime.os`; e `run.luau` que carrega cada `tests/*_test.luau` (lista fixa) e conta falhas, saindo com código 1 se houver alguma.

- [ ] Escrever `stub.luau` e `run.luau` com `expect_eq(a, b, msg)`.
- [ ] Rodar `D:\tools\luau\luau.exe tests/run.luau` → "0 tests" e exit 0.
- [ ] Commit `test: luau runner and tern stub`.

### Task 2: `lib/script.luau`

**Interfaces:** Produces `script.js_string(s) -> string`, `script.refresh(want_id: string?, dir: string, max_side: number) -> string`, `script.update(id: string, props: {[string]: any}) -> string`.

- [ ] Teste: `js_string('a"b\\c\nd')` = `"a\"b\\\\c\\nd"`; `refresh(nil, "C:/x y", 4096)` contém `Export(` e `"C:/x y"` e `want=null`; `refresh("ab\"c", …)` escapa o id.
- [ ] Implementar (snippet validado em 2026-10-13: visitor com `c.bounds`, profundidade ≤ 6, escolhe `want` se for de topo, senão o primeiro; `scale = Math.min(2, max_side / Math.max(w, h, 1))`, arredondada para baixo em 3 casas; `Export([id],"png",dir,{scale})`; `Print(JSON.stringify({v:1,layers:L,exported:id,scale}))`; documento vazio imprime `exported:null` e não chama Export).
- [ ] Contrato (descartável): gerar o snippet com `luau`, executar no `pen interactive -i tests/fixtures/sample.pen -o %TEMP%/scratch.pen`, conferir linha `{"v":1` e PNG ≤ 4096.
- [ ] Salvar a linha real em `tests/fixtures/sample.summary.txt` (saída completa do stdout, para `find_summary`).
- [ ] Commit `feat: execute snippets`.

### Task 3: `lib/doc.luau`

**Interfaces:** Consumes `tern.json.decode`. Produces `doc.find_summary(text) -> string?`, `doc.parse(line) -> (Summary?, string?)` com `Frame.layers` em pré-ordem sem o frame, `depth` relativo ao frame (filhos diretos = 1).

- [ ] Testes com `sample.summary.txt`: 2 frames (`Login` 390×844 com 3 layers; `Auto` 60×67 resolvido); `exported` e `scale`; texto sem linha → `nil`; JSON inválido → erro; `{"v":1,"layers":[],"exported":null}` → 0 frames sem erro; `v` diferente → erro "unsupported summary".
- [ ] Implementar; rodar; commit `feat: summary parsing`.

### Task 4: `lib/mcp.luau`

**Interfaces:** Produces `mcp.request(calls) -> string`, `mcp.parse(stdout, stderr, status, n) -> {Reply}`, `mcp.active_document(text) -> string?`.

- [ ] Testes: `request` gera 2 + n linhas (initialize id 0, notifications/initialized, tools/call ids 1..n); `parse` casa respostas fora de ordem; erro com "A file needs to be open" → `not_open`; stdout vazio com stderr de conexão → `no_app` para todas; `result.isError = true` → `tool_error`; `active_document` de ``Currently active canvas editor: `/C:/Users/a/b.pen` `` → `C:/Users/a/b.pen` no Windows e mantém `/home/a/b.pen` em outros SOs; sem linha → nil.
- [ ] Implementar; rodar; commit `feat: one-shot MCP client`.

### Task 5: `lib/launch.luau`

**Interfaces:** Produces `launch.pen_cli()`, `launch.mcp_server()`, `launch.pen_app(path)` retornando `Launch?` = `{argv, label}`.

- [ ] Testes (stub): Windows com `PATH` contendo `C:\npm` e `C:\npm\pen.cmd` + `index.mjs` existentes → `{"node", "C:\\npm\\node_modules\\@pen.dev\\cli\\dist\\index.mjs"}`; `TERN_PENCIL_CLI` apontando para `.mjs` → `{"node", path}`, para outro arquivo → `{path}`; Windows sem nada → nil; `mcp_server` Windows com `LOCALAPPDATA` → `…\Programs\Pen\resources\app.asar.unpacked\out\mcp-server-windows-x64.exe` + `-app desktop -agent tern-pencil-preview`, nil se não existe; macOS `pen_app` → `{"open", "-a", "Pen", path}`; linux `pen_cli` → `{"pen"}`.
- [ ] Implementar; rodar; commit `feat: launcher resolution`.

### Task 6: `lib/view.luau`

**Interfaces:** Consumes tipos de `doc`. Produces `view.render(state, cx) -> BlockView` (puro sobre os campos do estado listados no spec).

- [ ] Implementar views: problema (card com tom e badges Recarregar/Abrir no Pencil), carregando, principal (`row` com imagem e, com `panel`, coluna de layers `ui.list` com chaves = ids + inspetor `ui.kv`), dock (badge de modo, arquivo, frame i/n com nome, hora, aviso, atalhos).
- [ ] Verificação por tipos (`luau-analyze`) e no smoke; sem teste de unidade (é montagem de view).
- [ ] Commit `feat: views`.

### Task 7: `host.luau` + `plugin.toml`

**Interfaces:** Consumes todos os módulos acima.

- [ ] Manifesto conforme spec; block com `init/title/view/key/event/save`; ciclo de tick (live → file fallback) com `busy`, liveness por `tern.pane.list`, cache por frame no modo arquivo, comparação de bytes antes de `cx:blob`.
- [ ] `tern plugin types .` → `tern.d.luau`; `luau-analyze` sem erros.
- [ ] Commit `feat: preview block`.

### Task 8: `window.luau`

- [ ] Rota `.pen` (origens `files`, `palette`, `cli`; `how == "default"`; sem `line`; interruptor `route_pen`), comando de interruptor, comando "Pencil: preview the document open in Pencil".
- [ ] `luau-analyze`; commit `feat: routing and commands`.

### Task 9: Smoke real

- [ ] `tern plugin link D:\tern-pencil-preview`; `tern plugin list` mostra `pencil-preview … ready`.
- [ ] `tern open --split right tests/fixtures/sample.pen` → `tern ctl tree "[data-surface='plugin.pencil-preview.preview']"` mostra `sf-image` e dock "File".
- [ ] Abrir o fixture no Pen (`Pen.exe`), `Update` via MCP → dock "Live", imagem muda sem salvar; reverter.
- [ ] Teclas: `]` muda para `Auto`; `l` mostra layers.

### Task 10: Docs e publicação

- [ ] `README.md` (inglês), `LICENSE` (MIT), `CHANGELOG.md`.
- [ ] Repo público `SamuelFontess/tern-pencil-preview`, push; `tern plugin install github.com/SamuelFontess/tern-pencil-preview` funciona.
- [ ] PR no awesome-tern (`list.yml`, seção Blocks) seguindo `CONTRIBUTING.md`.

### Task 11 (fase 2): Edição leve

- [ ] `e` (texto) e `f` (fill) no modo Ao vivo com `input` na camada `layer`; aplica `script.update` pelo MCP; erro de validação de cor no dock; desabilitado no modo Arquivo.
- [ ] Teste de unidade de `script.update` (escaping, só `content`/`fill`); smoke no app.
