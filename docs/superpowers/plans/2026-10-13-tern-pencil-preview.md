# tern-pencil-preview Implementation Plan (incremento 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin Tern que mostra designs `.pen` num block nativo (imagem por frame, layers, inspetor), renderizados pelo `pen interactive` headless e atualizados quando o arquivo muda.

**Architecture:** A metade host define o block `pencil-preview.preview`. Um timer de 2 s compara o conteúdo do `.pen`; quando ele muda, roda o snippet `refresh` (resumo + Export) no `pen interactive` headless, lê o PNG e envia como blob. A metade window roteia aberturas de `.pen`. Os módulos puros em `lib/` são testados com `luau`.

**Tech Stack:** Luau (API de plugin do Tern 0.8.3, `--!strict`), `luau` 0.742 para testes, `luau-analyze` + `tern.d.luau` para tipos, pen CLI 0.3.9.

**Spec:** `docs/superpowers/specs/2026-10-13-tern-pencil-preview-design.md`

## Global Constraints

- Plugin id `pencil-preview`; block id `preview` (kind `pencil-preview.preview`); nome "Pencil Preview"; ícone `pen`.
- Todo processo via `tern.process.run` com callback e `timeout_ms`; nunca bloquear; host tem 2 s por chamada.
- O plugin nunca escreve o `.pen` do usuário (nenhum `save()`; `-o` aponta para `<data>/scratch`).
- O PNG enviado nunca passa de 4096 px por lado.
- Override: `TERN_PENCIL_CLI`.
- Ferramentas: `D:\tools\luau\luau.exe`, `D:\tools\luau\luau-analyze.exe` (fora do repo).

## File Structure

| Arquivo | Responsabilidade |
| --- | --- |
| `plugin.toml` | Manifesto |
| `host.luau` | Block: estado, ciclo, teclas, eventos, save |
| `window.luau` | Rota `.pen` e interruptor |
| `lib/script.luau` | `js_string`, `refresh`, `session` |
| `lib/doc.luau` | `find_summary`, `parse` |
| `lib/launch.luau` | `pen_cli`, `opener` |
| `lib/view.luau` | Views |
| `tests/run.luau`, `tests/stub.luau`, `tests/*_test.luau` | Runner, stub de `tern`, testes |
| `tests/fixtures/sample.pen`, `tests/fixtures/sample.stdout.txt` | Fixture e stdout real do headless |

---

### Task 1: Runner e stub
- [ ] `tests/stub.luau`: `stub.install({os?, env?, files?})` define o global `tern` com `json.encode/decode` (só para testes), `fs.exists`, `getenv` e `runtime.os`.
- [ ] `tests/run.luau`: roda uma lista fixa de `*_test.luau`, cada um exportando `{ [name] = fn }`; `expect_eq` e `expect_match`; sai com código 1 se algo falhar.
- [ ] `luau tests/run.luau` → "0 passed, 0 failed". Commit.

### Task 2: `lib/script.luau`
- [ ] Testes: `js_string('a"b\\c\nd')` → `"a\"b\\c\nd"` (JSON); `session({"X"})` → `execute({ input: "X" })\nexit()\n`; `refresh(nil, "C:/x y", 4096)` contém `want=null`, `"C:/x y"` e `Export(`; `refresh('a"b', …)` contém `"a\"b"`.
- [ ] Implementar o snippet do spec. Contrato descartável: executar o snippet gerado contra `tests/fixtures/sample.pen` no headless; gravar o stdout em `tests/fixtures/sample.stdout.txt`. Commit.

### Task 3: `lib/doc.luau`
- [ ] Testes com `sample.stdout.txt`: 2 frames; `Login` 390×844 com layers `Title` (depth 1, content), `Card` (depth 1) e `Avatar` (depth 2, parent `Card`); `Auto` 60×67; `exported` = id de `Login` e `scale` = 2. Formato do app: linha dentro de `{"message": "…"}` → mesmo resultado. Sem linha → `nil`. JSON inválido → erro. `{"v":1,"layers":[],"exported":null}` → 0 frames. `{"v":2}` → erro `unsupported summary version`.
- [ ] Implementar. Commit.

### Task 4: `lib/launch.luau`
- [ ] Testes: Windows com `PATH=C:\a;C:\npm`, `C:\npm\pen.cmd` e `C:\npm\node_modules\@pen.dev\cli\dist\index.mjs` existentes → argv `{"node", "C:\npm\node_modules\@pen.dev\cli\dist\index.mjs"}`; override `.mjs` → `{"node", p}`; override `.cmd` → node + index.mjs ao lado; override `pen.exe` → `{p}`; Windows sem nada → `nil`; Linux → `{"pen"}`; `opener` por SO.
- [ ] Implementar. Commit.

### Task 5: `plugin.toml`, `lib/view.luau`, `host.luau`
- [ ] Manifesto; view (cards de problema, carregando, principal com imagem, layers e inspetor, dock); block com ciclo, liveness, teclas, eventos e save.
- [ ] `tern plugin types .`; `luau-analyze` sem erros. Commit.

### Task 6: `window.luau`
- [ ] Rota e interruptor. `luau-analyze`. Commit.

### Task 7: Smoke real
- [ ] `tern plugin link`; `tern plugin list` → ready.
- [ ] `tern open --split right tests/fixtures/sample.pen` → `tern ctl tree` mostra `sf-image`; mudar uma cópia do fixture no disco → imagem atualiza; `]` → frame `Auto`; `l` → layers.

### Task 8: Docs e publicação
- [ ] `README.md` (inglês), `LICENSE` (MIT), `CHANGELOG.md`.
- [ ] Repo público, push, `tern plugin install github.com/SamuelFontess/tern-pencil-preview`.
- [ ] PR no awesome-tern (`list.yml`, Blocks).

Incrementos 2 (ao vivo, com a proteção de documento ativo) e 3 (edição leve) ganham planos próprios depois do smoke do incremento 1.
