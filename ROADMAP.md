# ROADMAP — Extensão GNOME "macOS-style Dock"

Extensão GNOME Shell criada **do zero**, sem fork de projetos existentes, para transformar o Dash/Dock padrão do GNOME em algo visualmente e comportamentalmente próximo ao Dock do macOS: ícones flutuantes, cantos arredondados, magnificação (ícone cresce ao passar o mouse, com efeito de "onda" nos vizinhos), animação de bounce ao abrir apps, indicadores de app aberto, etc.

**Stack de linguagem: TypeScript**, compilado para o GJS/ESM que o GNOME Shell executa em runtime. O Shell não entende TypeScript nativamente — ele só roda GJS (JavaScript com módulos ESM desde GNOME 45). Por isso, todo o código-fonte do projeto é escrito em `.ts`, com um passo de build que transpila para `.js` antes de empacotar/instalar a extensão. Isso te dá tipagem estática, autocomplete real das APIs do GObject Introspection (via `@girs`) e evita boa parte dos erros bobos de API que atormentam quem desenvolve extensões em JS puro.

---

## 0. Fundamentos que você precisa antes de escrever qualquer código

Não pule esta fase. A maior causa de abandono de projetos de extensão GNOME é começar a codar sem entender o modelo de objetos do Shell.

- **GJS (GNOME JavaScript)**: engine JS (baseada no SpiderMonkey do Firefox) que roda dentro do próprio `gnome-shell`. Sua extensão executa *dentro* do processo do compositor — bugs podem travar a sessão gráfica inteira.
- **GObject Introspection**: GJS expõe bibliotecas C (Clutter, St, Meta, Shell) como objetos JS via introspection. Você vai importar `St`, `Clutter`, `Meta`, `Shell`, `GLib`, `Gio` constantemente.
- **St (Shell Toolkit)**: toolkit de widgets usado pelo Shell (`St.BoxLayout`, `St.Icon`, `St.Button`, etc.) — é o que você usa para desenhar UI.
- **Clutter**: engine de cena/animação por trás do St. Toda animação (a magnificação, o bounce) é feita com `Clutter.Actor` e transições de propriedades (`ease()`, `Clutter.PropertyTransition`).
- **Estrutura do Shell UI**: entenda `Main.panel`, `Main.overview`, e principalmente `Main.layoutManager` e o código-fonte do Dash nativo do GNOME (`dash.js` em `js/ui/dash.js` do próprio gnome-shell) — é a base do que você vai substituir/estender.
- **Leia (não copie) o código do Dash to Dock**: mesmo criando do zero, ler a fonte de https://github.com/micheleg/dash-to-dock é o melhor "curso" prático que existe sobre como manipular o Dash de forma robusta entre versões do GNOME. Preste atenção em como eles fazem *overrides* de métodos sem quebrar o Shell original (o código-fonte deles é em JS puro, então ao portar ideias para TypeScript você vai precisar tipar manualmente algumas partes).
- **TypeScript + GJS**: entenda que TypeScript aqui é só uma camada de *developer experience* — em runtime, o Shell só vê JavaScript ESM puro. Você vai depender de **definições de tipo (`.d.ts`) geradas por introspection** para ter tipagem em `St`, `Clutter`, `Meta`, `Shell`, `GLib`, `Gio`, etc. O projeto de referência para isso é o **`ts-for-gir`** (https://github.com/gjsify/ts-for-gir), que gera os pacotes `@girs/*` usados para tipar APIs do GObject Introspection.

**Recursos de estudo recomendados:**
- Documentação oficial: https://gjs.guide/extensions/
- API docs GJS: https://gjs-docs.gnome.org/
- Código-fonte do gnome-shell (pasta `js/ui/`): https://gitlab.gnome.org/GNOME/gnome-shell

---

## 1. Ambiente de desenvolvimento

- **Distro de teste**: uma VM ou máquina secundária com GNOME (Fedora Workstation é o mais "puro" para isso; Ubuntu funciona mas tem patches próprios no Shell).
- **Ferramentas essenciais**:
  - `gnome-extensions` (CLI oficial para criar, instalar, empacotar e habilitar extensões)
  - `gnome-shell --version` para saber contra qual API você está codando
  - **Looking Glass** (`Alt+F2` → `lg`) — console de debug integrado do Shell, essencial para inspecionar objetos em tempo real
  - **Sessão aninhada** para testar sem derrubar sua sessão principal:
    ```bash
    dbus-run-session -- gnome-shell --nested --wayland
    ```
  - `journalctl -f /usr/bin/gnome-shell` para ver logs/erros em tempo real
- **Editor**: VSCode (ou similar) com suporte nativo a TypeScript — é onde a tipagem via `@girs` realmente compensa, com autocomplete e checagem de tipos em tempo de edição.
- **Toolchain de build TypeScript → GJS**:
  - `typescript` (compilador `tsc`) para checagem de tipos
  - Um bundler/transpilador para gerar o `.js` final que o Shell vai carregar — as opções mais usadas pela comunidade GNOME são **esbuild** (rápido, simples) ou **rollup** com plugin de TypeScript. Evite bundlers que assumem Node/browser (Webpack "puro", Vite sem ajustes) sem configurar o alvo corretamente para módulos ESM compatíveis com GJS.
  - `@girs/gnome-shell`, `@girs/st-1.0`, `@girs/clutter-1.0`, `@girs/meta-1.0`, etc. (gerados via `ts-for-gir`) como `devDependencies` — eles só existem em tempo de desenvolvimento, não vão para o pacote final.
  - Configurar `tsconfig.json` com `"module": "esnext"` e `target` compatível com a versão de SpiderMonkey usada pelo GNOME Shell que você está mirando.
- **Git** desde o commit zero, com branches por feature.

---

## 2. Estrutura inicial do projeto

Como o projeto é em TypeScript, a estrutura separa **código-fonte** (`src/`, versionado) do **build final** (`dist/`, gerado e é o que de fato é empacotado/instalado como extensão):

```
macos-dock@seunome.github.io/
├── src/
│   ├── extension.ts         # ponto de entrada (enable/disable)
│   ├── prefs.ts              # UI de preferências (GTK4/Adw)
│   └── lib/
│       ├── dockManager.ts    # lógica central do dock
│       ├── iconAnimations.ts # magnificação, bounce
│       └── settings.ts       # helper de GSettings
├── dist/                     # gerado pelo build — NÃO versionar (.gitignore)
│   ├── metadata.json
│   ├── extension.js
│   ├── prefs.js
│   ├── stylesheet.css
│   └── schemas/
├── metadata.json              # fonte do metadata (copiado para dist/ no build)
├── stylesheet.css              # fonte do CSS (copiado para dist/ no build)
├── schemas/
│   └── org.gnome.shell.extensions.macosdock.gschema.xml
├── tsconfig.json
├── package.json                # scripts de build, devDependencies (@girs/*, esbuild, typescript)
└── esbuild.config.js           # (ou rollup.config.js) script de bundling
```

Comece pelo `metadata.json`, um `tsconfig.json` mínimo e uma extensão "hello world" em `src/extension.ts` (só loga no console ao habilitar/desabilitar). Valide primeiro que o **pipeline completo funciona de ponta a ponta**: `tsc` checa os tipos → bundler gera `dist/extension.js` → `gnome-extensions` instala a partir de `dist/` → Shell carrega e loga corretamente. Só depois disso parta para UI de verdade.

---

## 3. Roadmap de desenvolvimento por fases

### Fase 1 — Esqueleto funcional (1–2 semanas)
- [ ] Configurar `tsconfig.json`, instalar `@girs/*` relevantes (`gnome-shell`, `st-1.0`, `clutter-1.0`, `meta-1.0`, `gio-2.0`, `glib-2.0`) e configurar o bundler (esbuild/rollup) para gerar `dist/extension.js` a partir de `src/extension.ts`
- [ ] Definir script único de build (`npm run build`) e, idealmente, um `npm run watch` que recompila automaticamente a cada alteração, para agilizar o ciclo de teste na sessão aninhada
- [ ] Extensão instala, habilita e desabilita sem erros no Looking Glass
- [ ] Decidir estratégia técnica: **estender o Dash nativo** (`imports.ui.main.overview.dash`) via monkey-patching de métodos, ou **substituir completamente** por um dock próprio ancorado na tela. (Substituir do zero dá mais controle visual, mas exige reimplementar drag-and-drop, indicadores de app, integração com favoritos — avalie o escopo real que você quer.)
- [ ] Implementar `enable()`/`disable()` limpos, sem vazar sinais/conexões (todo `connect()` precisa de `disconnect()` correspondente em `disable()` — é a causa nº1 de crash/memory leak em extensões). Em TypeScript, vale criar tipos próprios para IDs de sinal e um pequeno helper de "signal manager" para não perder o rastro das conexões.

### Fase 2 — Posicionamento e estilo visual (2–3 semanas)
- [ ] Dock flutuante (margem inferior, não colado na borda)
- [ ] Cantos arredondados, fundo translúcido (`stylesheet.css` com `border-radius`, `background-color` com alpha)
- [ ] Efeito de "vidro fosco" (blur) — CSS puro do St não faz blur nativo; avalie usar `Shell.BlurEffect` (API disponível desde GNOME 3.36+) aplicado ao actor de fundo
- [ ] Auto-hide (dock some quando não há mouse por perto / quando janela maximizada se sobrepõe)
- [ ] Redimensionamento dinâmico do dock conforme número de ícones

### Fase 3 — Animações estilo macOS (3–4 semanas, é o core do projeto)
- [ ] **Magnificação por proximidade do mouse**: capturar posição do ponteiro (`Clutter.Actor` motion events) e escalar o ícone sob o cursor com `ease()`, aplicando um fator decrescente nos ícones vizinhos (efeito "onda")
- [ ] **Animação de bounce** ao abrir um app (ícone pula) — usar `Clutter.PropertyTransition` com curva de easing tipo `EASE_OUT_BOUNCE`
- [ ] **Indicador de app aberto** (bolinha/traço abaixo do ícone, como no macOS) sincronizado com `Shell.WindowTracker` / `Shell.AppSystem`
- [ ] Transições suaves ao adicionar/remover ícones (fade + scale, não "pulo" abrupto)
- [ ] Cuidado com performance: animações em `Clutter` devem usar o compositor (GPU), evite recalcular layout a cada frame — teste com `looking glass` monitor de FPS

### Fase 4 — Configurabilidade (1–2 semanas)
- [ ] Criar schema GSettings (`.gschema.xml`) para: tamanho do ícone, intensidade da magnificação, posição do dock (baixo/esquerda/direita), auto-hide on/off, cor/opacidade do fundo
- [ ] Tela de preferências em `src/prefs.ts` usando GTK4 + libadwaita (padrão atual exigido pelo extensions.gnome.org para GNOME 42+), tipado com `@girs/gtk-4.0` e `@girs/adw-1`
- [ ] Persistir e reagir a mudanças de configuração em tempo real (sem precisar reiniciar o Shell)

### Fase 5 — Compatibilidade e robustez (contínuo, mas dedique 1–2 semanas focadas)
- [ ] Testar em múltiplas versões do GNOME Shell (idealmente as 3 últimas LTS/estáveis — hoje isso significa cobrir a faixa suportada pelo extensions.gnome.org)
- [ ] Testar em X11 **e** Wayland (comportamento de drag-and-drop e eventos de mouse pode diferir)
- [ ] Tratar conflitos com outras extensões populares (Dash to Dock, Dash to Panel, Blur my Shell) — no mínimo, detectar e avisar o usuário se houver conflito, já que várias delas mexem no mesmo `Main.overview.dash`
- [ ] Testes de estabilidade: habilitar/desabilitar repetidamente, trocar de usuário, suspender/retomar sessão, sem crash

### Fase 6 — Publicação (1 semana)
- [ ] Ler as guidelines de review do https://extensions.gnome.org (regras de licença GPL-compatível, proibição de código minificado/ofuscado, obrigatoriedade de declarar corretamente `shell-version` no metadata)
- [ ] Empacotar com `gnome-extensions pack`
- [ ] Submeter para review manual (pode levar dias/semanas — times de review são voluntários)
- [ ] Preparar README com screenshots/GIFs demonstrando a magnificação e o bounce (isso é o que vende a extensão)

### Fase 7 — Pós-lançamento
- [ ] Acompanhar issues no GitHub e reviews na loja
- [ ] Acompanhar mudanças de API a cada release major do GNOME (o Shell quebra API entre versões com frequência — isso é trabalho recorrente, não pontual)
- [ ] Roadmap de v2: suporte a múltiplos monitores, temas customizáveis, integração com "stacks" de pastas como no macOS

---

## 4. Riscos e pontos de atenção específicos

- **API instável entre versões do GNOME**: o que funciona no GNOME 45 pode quebrar no 46/47. Planeje desde já uma camada de compatibilidade (`if (majorVersion >= 45) {...}`) em vez de descobrir isso depois.
- **Reimplementar o Dash do zero é mais trabalho do que parece**: drag-and-drop de favoritos, integração com overview, menus de contexto (clique direito), suporte a "app running indicators" — tudo isso já existe no Dash nativo e você vai precisar recriar se optar por substituição total. Vale decidir isso conscientemente na Fase 1.
- **Performance**: animações mal otimizadas em GJS/Clutter travam o compositor inteiro (não só sua extensão) — teste sempre sob carga.
- **Memory leaks por sinais não desconectados** são a causa mais comum de bug reports em extensões GNOME. Adote a disciplina de sempre parear `connect`/`disconnect`.
- **Tipos `@girs` desatualizados ou incompletos**: como são gerados por introspection de uma versão específica do GNOME, pode haver mismatch entre o que o tipo diz e o que a API realmente aceita em versões diferentes do Shell. Trate os `.d.ts` como um guia, não como verdade absoluta — sempre valide comportamento real testando na sessão aninhada.
- **Build obrigatório antes de qualquer teste**: diferente de JS puro (onde você edita e recarrega direto), em TypeScript todo teste depende do passo de bundling estar rodando corretamente. Um `npm run watch` bem configurado é essencial, senão o ciclo de desenvolvimento fica lento e frustrante.
- **Não versionar `dist/`**: mantenha `dist/` no `.gitignore` e documente no README como rodar o build — evita divergência entre fonte e artefato compilado no repositório.

---

## 5. Cronograma estimado (part-time, ~10-15h/semana)

| Fase | Duração estimada |
|---|---|
| 0. Estudo/fundamentos | 1–2 semanas |
| 1. Esqueleto funcional | 1–2 semanas |
| 2. Estilo visual | 2–3 semanas |
| 3. Animações (core) | 3–4 semanas |
| 4. Preferências | 1–2 semanas |
| 5. Compatibilidade | 1–2 semanas |
| 6. Publicação | 1 semana |
| **Total até v1.0** | **~10–16 semanas** |

---

## 6. Referências úteis

- **`ts-for-gir`** (gerador dos tipos `@girs/*` a partir do GObject Introspection): https://github.com/gjsify/ts-for-gir
- **gjsify** (comunidade/organização por trás do ecossistema TypeScript para GJS, com exemplos de projetos e templates de bundler): https://github.com/gjsify
- Guia oficial GJS: https://gjs.guide/extensions/
- API Docs GJS: https://gjs-docs.gnome.org/
- Código-fonte gnome-shell (para estudo): https://gitlab.gnome.org/GNOME/gnome-shell
- Dash to Dock (leitura de referência, não fork): https://github.com/micheleg/dash-to-dock
- Portal oficial de extensões: https://extensions.gnome.org
- Guidelines de review: https://gjs.guide/extensions/review-guidelines/review-guidelines.html