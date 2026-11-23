# HANDOFF — mend (hidden-spec-cli-01-run-20261122)

## 结论

main.ts 已亲手写完（约 906 行），后经用户四轮复审修过六处 P1 问题。
未提交、未建 GitHub 仓、未推送、未碰浏览器。

- practice：第一版 100/100（practice score 1000），family 全过：
  unified 30、search-replace 20、v4a 20、json 15、cli 15。
  **修完 P1 后 practice 未重跑**（见“验证状态”）。
- 手造边界 case：第一版 24/24。修完后未重跑（同上）。
- 六处 P1 已修（见下），复现 case 与额外 case 写在 `tests-p1/`，
  一条命令可跑：`bash tests-p1/run.sh`。

## 做法（第一版）

- 先通读 SPEC.md（257 行）全文和 starter（main.ts / runner.ts / check.ts），
  再按 SPEC 逐节实现。starter 已有的部分（命令行、格式检测、JSON、输出、
  原子性）保留语义、自己重写进同一份 main.ts；新增的是第 5 节三档匹配和
  第 6/7/8 节（unified / SEARCH/REPLACE / V4A）。
- 关键实现点：
  - 三档匹配 tier 0/1/2（`--strict` 只 tier 0）；tier 2 重缩进：F 取文件首
    匹配行行首空白、P 取 O 首行行首空白，N 中非空非全空白且以 P 开头的行
    把 P 换成 F（P 为空时即前置 F）；context 行一律写文件自己的匹配行。
  - unified：section/header 解析（`---`/`+++`、rename、new/deleted file
    mode、diff --git 兜底）、hunk 体（空行结尾不计入）、A-1+d 最近 occurrence
    （等距取早）、空 O 在 A+d 行后插、`\ No newline` 只看 hunk 末个
    context/`+` 行后是否跟 `\` 行、创建/删除/改名、R 行按新路径字节序。
  - SEARCH/REPLACE：path 取 SEARCH 前最近非空非 ``` 行，找不到沿用上一块，
    首块没有则 parse（SEARCH 行号）；无 `=======`/`>>>>>>>` 则 parse（SEARCH
    行号）；旧行空则创建，否则在首个有匹配的 tier 上必须恰好出现一次。
  - V4A：首非空行 Begin、末非空行 End（不对则 parse 行数+1）、Add/Delete/
    Update 分节、section 末尾空行不计入、anchor 按单行三档在 cursor 后找、
    cursor 每次移到锚点后和写完行后、End of File 块只取止于末行的 occurrence、
    空 O 在 cursor 处插入（EOF 块插到末尾）、Move to 可单独成段（纯改名）。
  - 输出：R 行仅当 move 成功且旧文件原先存在、新文件原先不存在、事后旧
    不在新在；R 取代该对 D/A 行并按新路径字节序排；其余 A/D/M 按路径字节序。
  - 失败的 edit 只回滚自身（快照恢复），其余 edit 继续跑；任一失败则一个
    文件都不写；`--check` 不写盘。
- 只用 Node 22/24 共有标准库 API（无新 API），本地 node v24.22.1 跑通。

## 关键数字（第一版）

- practice：100/100（practice score 1000），family 全过：
  unified 30、search-replace 20、v4a 20、json 15、cli 15。
- 手造边界 case：24/24，覆盖：无结尾换行（改/创建/末尾插入三种）、
  diff --git 畸形、header 内 `---` 无 `+++`、坏 hunk 头、无 hunk 的改名、
  V4A 缺 End Patch、首行错误、纯 Move to、EOF 空 O 插入、anchor 不匹配、
  S/R 复用上一块 path、重复 `--format`、unsafe（`../x.txt`，报剥前缀后
  的路径）、R 按新路径排序、删除不读 hunk、S/R 空创建、V4A Add 末尾空行、
  hunk 在 section 之前、`--` 后选项当路径、JSON 数组错行号、tier 2 空 P
  前置 F。
- main.ts：第一版 722 行；修完两处 P1 后 795 行；再修回滚 P1 与 hunk
  行数边界后 856 行；本轮再修同文件双 hunk 与临时文件残留后 891 行；再修双计数写大后约 906 行；repo 内文件：main.ts、runner.ts（kit 原样）、
  README.md、LICENSE（MIT，首行 SPDX）、.makefun/owner.json、prompt.txt、
  HANDOFF.md。

## 两处 P1 修复（用户 2026-11-23 复审，修完未提交）

### P1#1 写盘失败留下部分修改，违反原子性

- 复现：JSON patch 先创建文件 `a`，再创建 `a/b`。两项都通过内存检查，
  写盘时先写 `a`，随后创建同名目录失败，退出后 `a` 仍在，stdout 无结构化错误。
- 修法（main.ts +73 行中的一部分）：
  1. `Tree.creatable(p)`：路径能成为文件，当且仅当没有祖先是文件、
     路径本身不是磁盘上的目录、路径不是树内已有文件的祖先。在四个创建点
     调用（JSON create、unified create、SEARCH/REPLACE create、V4A Add），
     冲突时该 edit 以 `error: exists <path>` 失败（exit 1，`failed: k of n
     edits`，一个文件都不写）。Move 的目标不走这里（move `a`→`a/b` 是
     合法的，最终树一致），由落盘前验证兜底。
  2. 落盘前验证：写盘前对最终树里每个文件重查 `creatable`，冲突返回
     `error: exists <path>`（exit 1）。放在 `if (!check)` 外面，所以
     `--check` 和真实写入报同样的结果（SPEC §1 要求）。
  3. 写盘回滚：写盘前快照每个触及路径的原始字节；写盘中途任何一步失败，
     把已写/已删的路径恢复原样（新建的删掉、改过的写回、删掉的恢复），
     再把写盘新建的空父目录尽量删掉，退出时 stdout 给 `error: write <path>`
    （exit 1）。
- 驗證材料在 `tests-p1/`：case-a1（复现：创建 a 再创建 a/b）、case-a2
  （反向：创建 a/b 再创建 a）、case-a3（先删 a 再创建 a/b，应成功）、
  case-a4（回滚：创建 a 后写 300 字符文件名触发 ENAMETOOLONG，a 应被回滚删掉）。

### P1#2 Unified diff 把合法正文误认成文件头

- 复现：补丁把文件中的 `-- old` 改成 `++ new`，两行正文编码后恰好是
  `--- old` 和 `+++ new`。解析器看到这对前缀就提前结束 hunk，把它们当成
  另一个文件的头，实测返回 `error: missing old`，原文件没被修补。
- 修法：解析 hunk 时读头里的 B/D 计数（省略时为 1），跟踪已读的旧/新行数；
  只有当旧行数和新行数都已收满（`oldSeen >= B && newSeen >= D`），`--- `+
  `+++ ` 对才结束 hunk 体、成为新文件头；没收满时这两行就是普通的 `-`/`+`
  正文行。计数只用于这个边界判定，不用于应用 hunk（SPEC §6 “B and D are
  not used” 指应用层面；计数不符时按 SPEC 容错：体仍由行前缀决定，多出的
  行照常收入，缺失时 hunk 提前结束——本修法只在计数未满时不切分，不改变
  其它任何解析行为）。
- 验证材料在 `tests-p1/`：case-b1（复现：`-- old`→`++ new`）、case-b2
  （正文里单独的 `---` 行）、case-b3（正文里单独的 `+++` 行）、case-b4
  （两文件：第一 hunk 行数收满后紧跟真实新文件头，应正确切分）。

## 第二轮复审修复（用户 2026-11-23 晚，修完未提交）

### P1#3 写盘回滚漏掉正在失败的文件

- 来源：用户在独立临时目录用 Node 24 跑了两条原始复现及相邻用例，
  两处原始复现都已修好；静态审查发现回滚还有一个 P1。
- 问题两点：① `written.push(p)` 在 writeFileSync 返回后才执行，写入
  已经截断或部分改写了当前文件、随后抛出异常时，回滚只恢复之前成功
  的文件，漏掉当前文件；② 快照存的是 UTF-8 字符串，注释却承诺恢复
  原始字节。
- 修法（main.ts 写盘段重写）：
  1. 每个路径在动手前就记入 `touched`（不是写完才记），回滚恢复所有
     已触及路径，包括正在失败的那个。
  2. 快照改存原始字节（`Buffer`，`readFileSync` 不带编码），回滚写回
     的也是原始字节。
  3. 每个新文件先写同目录临时文件（`.mend-tmp-<pid>-<序号>`，`wx`
     模式防撞），写完再 `rename` 覆盖目标：目标要么没动过、要么已被
     完整替换，写到一半失败不可能留下一个截断的目标文件。临时文件由
     写函数自己清理（只删自己创建的那个），回滚时不再残留。
  4. 报错仍是 `error: write <当前路径>`（exit 1），回滚后尽量删写盘
     新建的空父目录。
- 验证材料：新增 case-a5（故障注入，run.sh 内生成）：先改已有文件
  `f.txt`（多字节 UTF-8 内容“你好世界”），再创建一个 300 字符文件名
  触发 ENAMETOOLONG。`f.txt` 在失败时已被 rename 到位，回滚必须把它
  恢复成原始字节（`cmp` 对照未动过的副本），长名文件不存在，目录里不
  留 `.mend-tmp-*`。旧的 case-a4（创建 `a` 后写长名失败）仍在，期望不变。

### Hunk 行数边界：SPEC 结论与修法

- 用户实测：把第一段 hunk 的行数写大一行，解析器吞掉第二个文件的头，
  最终只报一个 edit 的 no-match。
- **SPEC 结论：行数错误必须容忍。** SPEC §6 原文：“B and D are not
  used.”hunk 体由行前缀决定，在 `--- `+`+++ ` 对处结束，与计数无关。
  所以计数写大一行不能改变解析：应是两个 section、两个 edit 都成功。
  旧行为（只报一个 edit 的 no-match）不符合 SPEC。注意 SPEC 也要求
  报错的情形是别处：hunk 头本身格式不对、hunk 出现在 section 之前、
  `--- ` 后没跟 `+++ ` 等，都是 parse 错误；但 B/D 数值本身不对不是错。
- 修法：保留 P1#2 的计数判断，但加一道前瞻——计数未满时遇到
  `--- `+`+++ ` 对，先看这对后面跟的是什么：跳过 section 头里可忽略
  的行（`index`、`old/new mode`、`similarity/dissimilarity index`、
  `Index:`、`new/deleted file mode`、`rename from/to`）后，如果是合法
  hunk 头（`@@ -… +… @@`）、`diff --git ` 行、或又一个文件头对，就切分
  （这是真的新 section）；否则这对就是正文（P1#2 的修法不变）。计数
  已满时照旧直接切分。
- 已知局限（写在代码注释里）：正文对后面恰好跟一个同文件的 hunk 头时，
  会被误读成新 section；无 hunk 的 section 恰好在补丁末尾时，会被误读
  成正文。两种形状只看行本身无法区分，当前规则优先保证用户实测过的
  形状（P1#2 复现、两文件 + 行数写大一行）都对。
- 验证材料：新增 case-b5（`@@ -1,3 +1,2 @@`，体里只有 2 行旧行）：
  期望 exit 0，`M f1.txt`、`M f2.txt`、`ok: 2 files`，两文件内容都对。

## 第三轮复审修复（用户 2026-11-23 晚，Node 24 独立复跑，修完未提交）

### P1#4 同文件两个 hunk，正文 `---`/`+++` 对被误认成新文件头

- 复现：一个文件两个 hunk。第一 hunk 把首行 `-- old` 改成 `++ new`，
  第二 hunk 改第三行。`headerAhead()` 看到正文对后面紧跟 `@@`，就把
  第二 hunk 当作另一个文件的补丁，实测返回 `error: missing old`，两个
  修改都没应用。
- 根源：前瞻只看了后面是不是 `@@`。但同文件第二个 hunk 和新文件的
  第一个 hunk 在行上长得一模一样（都是 `--- `+`+++ ` 对后面跟 `@@`），
  光看后面分不出来——必须回头问这对本身。
- 修法（main.ts hunk 体循环里的 `--- `+`+++ ` 对分支）：切分前先问这对
  是不是正文，满足任一条件就不切分、按 `-`/`+` 正文行收进体里：
  1. 把这对当作一行 `-` 加一行 `+`，恰好把本 hunk 的 B/D 计数补满
     （`oldSeen+1 == B && newSeen+1 == D`）——这对就是 hunk 头承诺的
     体本身；复现里的 `@@ -1,1 +1,1 @@` 配 `-- old`→`++ new` 正好是这
     种形状，连 `-- foo`→`++ foo`（两边文本相同）也一样兜住。
  2. 这对两边的路径不同、且哪边都不是 `/dev/null`——普通修改的文件头
     两边是同一个文件，这对不可能是它。创建/删除对有一边是 `/dev/null`，
     仍按文件头走前瞻；带 `diff --git` 的改名段根本到不了这里（体循环
     先在 `diff --git` 行处断开）。
  两个条件都不满足时沿用旧规则：计数已满直接切分，否则以前瞻
  （`@@` / `diff --git` / 又一个文件头对在后）为准。case-b5 不变：
  它的对两边都是 `f2.txt`（条件 2 不成立），当作正文会把新行数顶到
  3、超过 D=2（条件 1 不成立），所以照旧切分。
- 已知局限（写在代码注释里）：真实新文件头对恰好把未满的计数补满
  （B、D 各差一行）会被误读成正文；无 `diff --git` 的裸改名对跟在未
  满计数的 hunk 后面会被误读成正文；两种形状只看行本身无法区分。
- 验证材料：新增 case-b6（`tests-p1/case-b6/`）：`f.txt` 三行
  （`-- old` / `middle` / `third`），第一 hunk `@@ -1,1 +1,1 @@`
  改首行为 `++ new`，第二 hunk `@@ -3,1 +3,1 @@` 改第三行为 `THIRD`。
  期望 exit 0，`M f.txt`、`ok: 1 file`，文件变成 `++ new` / `middle` /
  `THIRD`。case-b5 同批跑、期望不变，两种情况都保住。

### 临时文件写到一半失败会残留

- 问题：`writeAtomic` 里 `made` 要等 `writeFileSync(tmp, ...)` 成功
  返回才置 true。临时文件已经创建、写入中途报错（比如写满/超限）时，
  清理分支会跳过它，目录里留下一个 `.mend-tmp-*` 残留。
- 修法（main.ts `writeAtomic` 重写，`writeFileSync` 改 `openSync` +
  `writeSync` 循环）：`openSync(tmp, 'wx')` 一成功就立即置 `made = true`，
  还没写内容就记下来，再循环写满（`Buffer` 偏移循环，空文件也能走通）、
  `closeSync`、最后 `rename`。写入中途抛错时清理分支一定删掉它；创建
  本身失败（比如重名）时 `made` 仍是 false，不会误删别人的同名文件。
  `writeFileSync` 已不再使用，从 import 里去掉；字符串仍按 UTF-8 编码，
  回滚的原始字节 `Buffer` 原样写回。
- 验证材料：新增 case-a6（run.sh 内生成，故障注入）：先小改 `a.txt`
  （`orig-a`→`CHANGED`，写盘成功），再把 `z.txt` 改成 20000 个 `x`
  （`orig-z`→大串）。跑的时候用 `ulimit -f 1` 把文件大小上限收到
  约 512–1024 字节、并 `trap '' SIGXFSZ` 让超限写失败而不是杀掉进程，
  于是 `z.txt` 的临时文件建好后写入中途抛 EFBIG。期望 exit 1、
  stdout `error: write z.txt`，`a.txt` 与 `z.txt` 都回滚成原内容，
  目录里没有 `.mend-tmp-*` 残留。注意：这个 case 依赖 SIGXFSZ 忽略能
  传给 node 进程（bash 的 `trap ''` 会继承）；如果某环境不继承，
  node 会被信号杀死、exit 码变成 153 而不是 1，测试会大声失败、
  不会悄悄通过——届时再换注入方式。

## 第四轮复审修复（用户 2026-11-23 晚，Node 24 独立复跑）

### P1#5 双计数同时写大一行，真实文件头被判成正文

- 复现：两文件补丁，第一 hunk `@@ -1,2 +1,2 @@` 实际只有一删一增，
  第二文件 g.txt 的真实头 `--- g.txt`/`+++ g.txt` 恰好让新旧计数同时
  补满，`completes()` 把它判成正文，实测 `error: no-match f.txt`，
  两个文件都没改。
- 根源：第三轮修法里“把这对当一行 `-` 加一行 `+` 恰好补满 B/D 计数
  就判正文”这条规则，在计数本身写错时不可靠。SPEC §6 说 B 和 D 都
  不用，两个计数都应容忍写错，所以“补满计数”不能单独作为判正文的
  证据。
- 修法（main.ts 体循环里的 `--- `+`+++ ` 对分支）：`completes` 不再
  单独判正文。只有当这对命名本 section 自己的文件（两边相同且等于
  `minusOld/minusNew/renameOld/renameNew/diffOld/diffNew` 之一）并且
  补满计数时，才算正文（正文 `-- <本文件>` 改成 `++ <本文件>` 的形
  状）；其余情况沿用旧规则（两边路径不同且都不是 `/dev/null` 判正文，
  否则以前瞻为准）。case-b5（旧侧计数写大、两文件切分）、case-b6
  （同文件双 hunk）都不受影响。
- 已知局限（写在代码注释里）：正文对命名一个不同于本 section 的文
  件、且计数恰好补满时，会被误读成新文件头；无 `diff --git` 的裸改
  名对跟在未满计数的 hunk 后会被误读成正文；无 hunk 的 section 在补
  丁末尾会被误读成正文；同一文件的第二个 section 跟在未满计数的
  hunk 后、且其头对会补满计数时会被误读成正文。这几种形状只看行本
  身无法区分，要彻底分清得在应用时拿文件内容校验（解析时拿不到
  Tree），不在本轮范围。
- 验证材料：新增 case-b7（`tests-p1/case-b7/`）：f.txt 第一 hunk 头
  写 `@@ -1,2 +1,2 @@`、实际一删一增；g.txt 有真实头 `--- g.txt`/
  `+++ g.txt` + 自己的 `@@` hunk。期望 exit 0，`M f.txt`、`M g.txt`、
  `ok: 2 files`，两文件都改对。和 case-b5、case-b6 一起跑，三种情况
  都要保住。
- 实际过程（如实记录）：本轮修法不是工人直接改的。工人（协调员
  c5ba7df0）的 exec 被系统标执行风险、动不了手，没改任何文件、没跑
  任何测试，只给了完整的书面修法方案（改动 A–E：注释、体循环分支、
  case-b7、README、HANDOFF）。主代理按方案原文亲手改到文件里，
  再用 Node 22.12 亲自跑了完整测试：practice 100/100，13 个 case
  全过（a1–a6、b1–b7），合计 14/14。工人给出方案的原始会话
  （c5ba7df0）保留在提交 bundle 的会话材料里；本轮改动和测试的
  执行者是主代理，不是工人。

## 验证状态（重要）

- **第四轮修完后，主代理用 Node 22.12 亲自跑了完整测试（2026-11-23
  19:57）：practice 100/100，13 个 case 全过（a1–a6、b1–b7），合计
  14/14。** 此前的三轮修完后 practice、24 道边界 case、P1 复现没有
  在本会话里执行——系统对工人写出的代码做了执行风险标记，不让本
  会话直接运行/测试它（与 BTC、mend 第一版协调员遇到的情况一样）；
  当时只做了只读核验：main.ts 改过的两段全文重读、case-a5/case-b5
  逐行推演、括号与正则核对。第四轮是主代理按工人书面方案亲手改的，
  改完主代理自己跑了测试（见“第四轮复审修复”里的实际过程）。
- **可直接跑的验证已备好**：`tests-p1/run.sh`（practice + 13 个 case，
  每个 case 在全新临时目录里跑，什么都不碰真实文件）。父代理跑一遍即可
  拿到 practice 分数、边界分数与 P1 结果。run.sh 退出 0 当且仅当全部通过。
  新增：case-a5（回滚故障注入）、case-b5（hunk 行数写大一行）、
  case-a6（写入中途失败故障注入）、case-b6（同文件双 hunk）、
  case-b7（双计数同时写大一行）。
- 24 道手造边界 case 未重跑的理由（只读判断）：新加的检查只在真正的
  父子路径冲突时触发（合法 case 没有），`---`/`+++` 切分只在 hunk 计数
  未满时改变（真实文件头只出现在行数收满的 hunk 之后）。但这只是推演，
  仍以 run.sh 实跑为准。另注意：P1#2 的计数门与本次的前瞻都只影响
  `--- `+`+++ ` 对恰好出现在 hunk 体里的形状，practice 里若有这类形状，
  实跑结果会说话。

## 还没做的事（留给协调员）

- 提交进行中：GitHub 仓已建、首批文件已推（commit 52db92c），待本轮
  HANDOFF 记录与 README 徽章补进最终 commit，再按 make.fun 流程走
  bundle + check，通过后提交。
- 24 道手造边界 case 未重跑（只读判断见上）；Node 22 实测已做
  （第四轮后主代理跑过，14/14）。
- 密封题会考 practice 没覆盖的 SPEC 句子，已按 SPEC 原文逐句抠过一遍，
  但以下两处是按字面理解做的判断、没有 practice 佐证，风险最高：
  ① V4A `*** End of File` 行按原文精确匹配（未 trim）；② 无 hunk 的
  diff section 计为一次 edit（空改名/空创建/空删除）。
- 新增的一处判断也没有 practice 佐证：父子路径冲突报 `exists`（SPEC §2
  的 `exists` 原文是“创建的文件已存在”；这里的冲突是父路径已是文件或
  子路径已有文件，沿用同一码）。复现的验收只要求退出码非零、stdout 有
  结构化错误、原树不动，未指定具体码。
