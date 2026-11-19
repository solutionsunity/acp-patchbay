// Every command a line runs is judged by the same rules, wherever it sits;
// what the text can't show asks (#104). The reading is the real bash
// grammar; the rules are plain data.
import { describe, expect, it } from "vitest";
import { judgeCommands, type RuleLayers } from "../src/orchestrator/command-judge";
import { ShellReader } from "../src/orchestrator/shell-reading";
import { unruledWhy } from "../src/shared/command-rules";
import { commandsRunUnasked, DEFAULT_COMMAND_POLICY, effectiveCommandPolicy, type CommandPolicyView } from "../src/shared/protocol";
import type { CommandRule } from "../src/orchestrator/stores/permission-rules";
import { SHELL_GRAMMAR } from "./support/shell-grammar";

const reader = new ShellReader(SHELL_GRAMMAR);
/** A line as bash reads it — the script `bash -c` is handed, which the
 * reader reads through. */
const readLine = (text: string) => reader.readRun("bash", ["-c", text]);

const allow = (pattern: string): CommandRule => ({ kind: "command", pattern, verdict: "allow" });
const ask = (pattern: string): CommandRule => ({ kind: "command", pattern, verdict: "ask" });
const deny = (pattern: string): CommandRule => ({ kind: "command", pattern, verdict: "deny" });
const denyWord = (pattern: string): CommandRule => ({ kind: "word", pattern, verdict: "deny" });
const askWord = (pattern: string): CommandRule => ({ kind: "word", pattern, verdict: "ask" });

function layers(workspace: CommandRule[], machine: CommandRule[] = []): RuleLayers {
  return { workspace, machine };
}

async function line(text: string, rules: RuleLayers) {
  return judgeCommands(await readLine(text), rules);
}

async function verdict(text: string, rules: RuleLayers) {
  return (await line(text, rules)).verdict;
}

describe("reading a line — every command it runs", () => {
  it("finds each command in chains, pipelines, loops, subshells, conditions and functions", async () => {
    const reading = await readLine(
      'a 1 && b 2 || c; d | e\nfor f in x; do g "$f"; done; (h); { i; }; if j; then k; fi; while l; do m; done; case x in y) n;; esac; fn() { o; }',
    );
    expect(reading.commands.map((c) => c.words[0])).toEqual(["a", "b", "c", "d", "e", "g", "h", "i", "j", "k", "l", "m", "n", "o"]);
    expect(reading.unreadable).toEqual([]);
  });

  it("reads words as the command receives them — quotes gone, boundaries kept", async () => {
    const [cmd] = (await readLine(`s'u'do rm "a b" c\\ d 'e'"f"`)).commands;
    expect(cmd!.words).toEqual(["sudo", "rm", "a b", "c d", "ef"]);
    expect(cmd!.text).toBe('sudo rm "a b" "c d" ef');
  });

  it("an argument only known when it runs is kept as written — it hides no command", async () => {
    const reading = await readLine('for f in *.log; do rm "$f" $HOME; done');
    expect(reading.commands).toEqual([{ text: 'rm "$f" $HOME', words: ["rm", '"$f"', "$HOME"] }]);
    expect(reading.unreadable).toEqual([]);
  });

  it("assignments and redirects run nothing themselves — the command is its words", async () => {
    const reading = await readLine("FOO=1 npm test 2>&1 > out.txt | tee log");
    expect(reading.commands.map((c) => c.text)).toEqual(["npm test", "tee log"]);
  });

  it("`export`, `declare` and `unset` are commands named by their keyword", async () => {
    const reading = await readLine("export WATCH=rm; unset X");
    expect(reading.commands.map((c) => c.words)).toEqual([["export", "WATCH=rm"], ["unset", "X"]]);
  });
});

describe("reading a line — what can't be seen asks", () => {
  it.each([
    ["$WATCH -rf /", "the command's name is only known when it runs"],
    ['eval "ls"', "eval runs its arguments as a command"],
    ["echo $(curl x)", "a command substitution — its output is only known when it runs"],
    ["echo `id`", "a command substitution — its output is only known when it runs"],
    ["diff <(ls a) b", "a command substitution — its output is only known when it runs"],
    ["cat <<EOF\nhi $(whoami)\nEOF", "a command substitution — its output is only known when it runs"],
    ['echo "unterminated', "not bash this reader can follow"],
  ])("%s", async (text, reason) => {
    const reading = await readLine(text);
    expect(reading.unreadable.map((u) => u.reason)).toContain(reason);
    expect(await verdict(text, layers([allow("*")]))).toBe("ask");
  });

  it("a quoted heredoc expands nothing — it hides nothing", async () => {
    const reading = await readLine("cat <<'EOF'\n$(whoami)\nEOF");
    expect(reading.unreadable).toEqual([]);
    expect(reading.commands.map((c) => c.text)).toEqual(["cat"]);
  });
});

describe("reading through a shell", () => {
  it("bash -c is transparent: the script's commands are what run", async () => {
    const reading = await reader.readRun("bash", ["-lc", "npm test && rm -rf build"]);
    expect(reading.commands.map((c) => c.text)).toEqual(["npm test", "rm -rf build"]);
  });

  it("a shell further along is read through too — the outer command still judged", async () => {
    const reading = await readLine(`sudo sh -c 'rm -rf /'`);
    expect(reading.commands.map((c) => c.text)).toEqual(['sudo sh -c "rm -rf /"', "rm -rf /"]);
  });

  it("nested scripts are read to the bottom", async () => {
    const reading = await reader.readRun("bash", ["-c", `sh -c "bash -c 'rm x'"`]);
    expect(reading.commands.map((c) => c.text)).toEqual(["rm x"]);
  });

  it("a script file is the command itself; `echo bash` is an argument", async () => {
    expect((await reader.readRun("bash", ["deploy.sh"])).commands.map((c) => c.text)).toEqual(["bash deploy.sh"]);
    expect((await readLine("echo bash")).commands.map((c) => c.text)).toEqual(["echo bash"]);
  });

  it.each([
    [["bash"], "bash reads its commands from its input"],
    [["bash", "-s", "x"], "bash reads its commands from its input"],
    [["zsh"], "zsh reads its commands from its input"],
    [["fish", "-c", "ls"], "a fish script — only bash and zsh are read"],
    [["pwsh", "-Command", "ls"], "a pwsh script — only bash and zsh are read"],
    [["cmd.exe", "/c", "dir"], "a cmd script — only bash and zsh are read"],
  ])("%j asks: %s", async (argv, reason) => {
    const reading = await reader.readRun(argv[0]!, argv.slice(1));
    expect(reading.unreadable.map((u) => u.reason)).toEqual([reason]);
  });

  it("a script only known when it runs asks", async () => {
    const reading = await readLine('bash -c "$SCRIPT"');
    expect(reading.unreadable.map((u) => u.reason)).toEqual(["the script is only known when it runs"]);
  });

  it("a grammar that can't load reads every script as unreadable — plain argv needs none", async () => {
    const lost = new ShellReader({ runtime: "/nowhere/tree-sitter.wasm", grammars: { bash: "/nowhere/bash.wasm", zsh: "/nowhere/zsh.wasm" } });
    expect((await lost.readRun("bash", ["-c", "ls"])).unreadable).toEqual([{ text: "ls", reason: "the bash reader didn't load" }]);
    expect((await lost.readRun("zsh", ["-c", "ls"])).unreadable).toEqual([{ text: "ls", reason: "the zsh reader didn't load" }]);
    expect((await lost.readRun("npm", ["test"])).commands.map((c) => c.text)).toEqual(["npm test"]);
  });

  it("plain argv is one command, whatever its arguments hold — no shell reads them", async () => {
    const reading = await reader.readRun("echo", ["a; rm -rf /", "$(id)"]);
    expect(reading).toEqual({ commands: [{ text: 'echo "a; rm -rf /" $(id)', words: ["echo", "a; rm -rf /", "$(id)"] }], unreadable: [] });
  });
});

describe("reading a zsh script — with zsh's own grammar (#165)", () => {
  const zsh = async (text: string) => reader.readRun("/bin/zsh", ["-l", "-c", text]);
  const ran = async (text: string) => (await zsh(text)).commands.map((c) => c.text);
  const asks = async (text: string) => (await zsh(text)).unreadable.map((u) => u.reason);

  it("the script's commands are what run, as with bash", async () => {
    expect(await ran("printf '%s\\n' hello")).toEqual(["printf %s\\n hello"]);
    expect(await ran("npm test && rm -rf build; FOO=1 git push")).toEqual(["npm test", "rm -rf build", "git push"]);
    expect(await asks("npm test && rm -rf build")).toEqual([]);
  });

  it.each([
    ["for f (a b) rm $f", ["rm $f"]],
    ["foreach f (a b); rm $f; end", ["rm $f"]],
    ["repeat 3 curl example.com", ["curl example.com"]],
    ["() { rm -rf x }; function f { echo hi }", ["rm -rf x", "echo hi"]],
    ["{ make } always { rm -rf tmp }", ["make", "rm -rf tmp"]],
    ["if [[ -n $x ]] { echo yes } else { rm no }", ["echo yes", "rm no"]],
    ["for f in *.txt(N); do print -r -- ${f:t}; done", ["print -r -- ${f:t}"]],
    ["sleep 1 &! ; make &|", ["sleep 1", "make"]],
  ])("zsh's own forms are read: %s", async (script, commands) => {
    expect(await ran(script)).toEqual(commands);
    expect(await asks(script)).toEqual([]);
  });

  it("`=name` is the program `name`: a rule on it holds", async () => {
    expect(await ran("=rm -rf x")).toEqual(["rm -rf x"]);
    expect(judgeCommands(await zsh("=rm -rf x"), layers([allow("*"), denyWord("rm")])).verdict).toBe("deny");
    // bash has no such reading: there the word is the program's name as written
    expect((await readLine("=rm -rf x")).commands.map((c) => c.text)).toEqual(["=rm -rf x"]);
  });

  it.each([
    ["echo $(id)", "a command substitution — its output is only known when it runs"],
    ["x=`whoami`", "a command substitution — its output is only known when it runs"],
    ["diff =(ls a) <(ls b)", "a command substitution — its output is only known when it runs"],
    ["$=cmd arg", "the command's name is only known when it runs"],
    ["${(e)x}", "the command's name is only known when it runs"],
    ['eval "ls"', "eval runs its arguments as a command"],
    ["if [[ -d x ]] rm -rf x", "not zsh this reader can follow"],
  ])("what the text can't show asks: %s", async (script, reason) => {
    expect(await asks(script)).toContain(reason);
  });

  it("each script is read as the shell handed it: zsh inside bash, bash inside zsh", async () => {
    expect((await readLine(`zsh -c 'for f (a b) rm $f'`)).commands.map((c) => c.text)).toEqual(["rm $f"]);
    // the same words handed to bash are not bash: it asks
    expect(await asks(`bash -c 'for f (a b) rm $f'`)).toContain("not bash this reader can follow");
  });

  it("a wildcard allow covers a zsh script, and a deny inside it still wins", async () => {
    expect(judgeCommands(await zsh("printf hello"), layers([allow("*")])).verdict).toBe("allow");
    expect(judgeCommands(await zsh("make && rm -rf /"), layers([allow("*"), deny("rm *")])).verdict).toBe("deny");
  });
});

describe("judging — what stands around the rules (#165)", () => {
  const under = async (text: string, rules: RuleLayers, policy: CommandPolicyView) => judgeCommands(await readLine(text), rules, policy);
  const unruled = (verdict: CommandPolicyView["unruled"]): CommandPolicyView => ({ alwaysAllow: false, unruled: verdict });
  const ALWAYS: CommandPolicyView = { alwaysAllow: true, unruled: "ask" };

  it("ask is how it starts: a command no rule decides asks", async () => {
    expect(judgeCommands(await readLine("ls"), layers([])).policy).toEqual(DEFAULT_COMMAND_POLICY);
    expect((await under("ls", layers([]), DEFAULT_COMMAND_POLICY)).verdict).toBe("ask");
  });

  it("allow is a blacklist: what no rule decides runs, a deny rule still denies, an ask rule still asks", async () => {
    const rules = layers([deny("rm *"), ask("git push*")]);
    expect((await under("npm test", rules, unruled("allow"))).verdict).toBe("allow");
    expect((await under("npm test && rm -rf build", rules, unruled("allow"))).verdict).toBe("deny");
    expect((await under("npm test && git push", rules, unruled("allow"))).verdict).toBe("ask");
    const judged = await under("npm test", rules, unruled("allow"));
    expect(judged.commands).toEqual([{ text: "npm test", verdict: "allow", by: null, also: [] }]);
  });

  it("deny is a whitelist: only what an allow rule names runs", async () => {
    const rules = layers([allow("npm *")]);
    expect((await under("npm test", rules, unruled("deny"))).verdict).toBe("allow");
    expect((await under("npm test && curl example.com", rules, unruled("deny"))).verdict).toBe("deny");
  });

  it("what can't be seen is what no rule decided: it gets the same answer", async () => {
    const rules = layers([allow("echo *")]);
    expect((await under("echo $(id)", rules, unruled("ask"))).verdict).toBe("ask");
    expect((await under("echo $(id)", rules, unruled("allow"))).verdict).toBe("allow");
    expect((await under("echo $(id)", rules, unruled("deny"))).verdict).toBe("deny");
    // and so is a line that runs nothing
    expect((await under("", layers([]), unruled("allow"))).verdict).toBe("allow");
    expect((await under("", layers([]), unruled("deny"))).verdict).toBe("deny");
  });

  it("under allow a deny rule stops what is read — and only that", async () => {
    const rules = layers([deny("rm *")]);
    expect((await under("rm -rf x", rules, unruled("allow"))).verdict).toBe("deny");
    expect((await under("echo $(id); rm -rf x", rules, unruled("allow"))).verdict).toBe("deny");
    // hidden where the reader can't see, it runs: the deny rule never met it
    expect((await under('eval "rm -rf x"', rules, unruled("allow"))).verdict).toBe("allow");
  });

  it("always allow sets the rules and the choice aside: every line runs, no rule consulted", async () => {
    const rules = layers([deny("rm *"), ask("git push*")]);
    for (const text of ["rm -rf /", "git push", "echo $(id)", 'eval "x"', ""]) {
      const judged = await under(text, rules, ALWAYS);
      expect(judged.verdict).toBe("allow");
      expect(judged.commands.every((c) => c.verdict === "allow" && c.by === null && c.also.length === 0)).toBe(true);
    }
    expect((await under("rm -rf /", rules, { alwaysAllow: true, unruled: "deny" })).verdict).toBe("allow");
  });

  it("says why, for a command no rule decided", () => {
    expect(unruledWhy(DEFAULT_COMMAND_POLICY)).toBe("no rule matched");
    expect(unruledWhy(unruled("allow"))).toBe('no rule matched — "When no rule decides" is allow');
    expect(unruledWhy(unruled("deny"))).toBe('no rule matched — "When no rule decides" is deny');
    expect(unruledWhy(ALWAYS)).toBe('"Always allow commands" is on');
  });

  it("each layer holds its own; a workspace's choice wins where it makes one, and either layer's switch is on", () => {
    const machine: CommandPolicyView = { alwaysAllow: false, unruled: "allow" };
    expect(effectiveCommandPolicy(machine, { alwaysAllow: false, unruled: null })).toEqual({ alwaysAllow: false, unruled: "allow" });
    expect(effectiveCommandPolicy(machine, { alwaysAllow: false, unruled: "ask" })).toEqual({ alwaysAllow: false, unruled: "ask" });
    expect(effectiveCommandPolicy(machine, { alwaysAllow: true, unruled: "deny" })).toEqual({ alwaysAllow: true, unruled: "deny" });
    expect(effectiveCommandPolicy({ alwaysAllow: true, unruled: "ask" }, { alwaysAllow: false, unruled: null }).alwaysAllow).toBe(true);
    expect([DEFAULT_COMMAND_POLICY, unruled("deny"), unruled("allow"), ALWAYS].map(commandsRunUnasked)).toEqual([false, false, true, true]);
  });
});

describe("judging — the rules over each command (#104)", () => {
  it("a chain is as safe as its worst command: an allowed head carries nothing", async () => {
    const rules = layers([allow("kubectl get *")]);
    expect(await verdict("kubectl get pods", rules)).toBe("allow");
    expect(await verdict("kubectl get pods && rm -rf /", rules)).toBe("ask");
    expect(await verdict("kubectl get pods && rm -rf /", layers([allow("kubectl get *"), deny("rm *")]))).toBe("deny");
  });

  it("a word matches a word, never a piece of one", async () => {
    const rules = layers([denyWord("--watch"), allow("*")]);
    expect(await verdict("kubectl get pods --watch", rules)).toBe("deny");
    expect(await verdict("cat watch.log", rules)).toBe("allow");
  });

  it("a word is found in every command of the line, quotes and paths no disguise", async () => {
    const rules = layers([denyWord("sudo"), allow("*")]);
    expect(await verdict("ls && sudo rm x", rules)).toBe("deny");
    expect(await verdict("s'u'do rm x", rules)).toBe("deny");
    expect(await verdict("/usr/bin/sudo rm x", rules)).toBe("deny");
    expect(await verdict("cat sudo.log", rules)).toBe("allow");
    expect(await verdict("cat /tmp/sudo", rules)).toBe("allow"); // a path argument is not the program
  });

  it("`*` in a word matches within the word", async () => {
    expect(await verdict("terraform destroy-all", layers([denyWord("destroy*"), allow("*")]))).toBe("deny");
  });

  it("a loop with every command allowed is allowed; one rejected word rejects it", async () => {
    const rules = layers([allow("echo *"), allow("ls *"), denyWord("rm")]);
    expect(await verdict("for f in a b; do echo $f; ls $f; done", rules)).toBe("allow");
    expect(await verdict("for f in a b; do echo $f; rm $f; done", rules)).toBe("deny");
  });

  it("within a layer, deny beats ask beats allow — whatever the list order", async () => {
    const rules = layers([allow("npm *"), ask("npm test*"), deny("npm publish*")]);
    expect(await verdict("npm publish", rules)).toBe("deny");
    expect(await verdict("npm test", rules)).toBe("ask");
    expect(await verdict("npm run build", rules)).toBe("allow");
  });

  it("the workspace's answer wins wherever it has one; the machine's answers the rest", async () => {
    const rules = layers([allow("./deploy.sh"), deny("npm publish*")], [deny("./deploy.sh"), allow("npm *"), denyWord("sudo")]);
    expect(await verdict("./deploy.sh", rules)).toBe("allow");
    expect(await verdict("npm publish", rules)).toBe("deny");
    expect(await verdict("npm run build", rules)).toBe("allow");
    expect(await verdict("sudo ls", rules)).toBe("deny");
  });

  it("names the deciding rule, its layer, and every rule that matched and lost", async () => {
    const judged = await line("npm test", layers([allow("npm *"), askWord("test")], [allow("npm test")]));
    expect(judged.commands).toEqual([
      {
        text: "npm test",
        verdict: "ask",
        by: { rule: askWord("test"), layer: "workspace" },
        also: [
          { rule: allow("npm *"), layer: "workspace" },
          { rule: allow("npm test"), layer: "machine" },
        ],
      },
    ]);
  });

  it("no rule, or a line that runs nothing, asks — never a silent allow", async () => {
    expect(await line("rm -rf /", layers([]))).toMatchObject({ verdict: "ask", commands: [{ by: null, verdict: "ask" }] });
    expect(await verdict("", layers([allow("*")]))).toBe("ask");
    expect(await verdict("X=1", layers([allow("*")]))).toBe("ask");
  });

  it("a part that can't be seen asks, but a rejected command still rejects the line", async () => {
    const rules = layers([allow("*"), denyWord("sudo")]);
    expect(await verdict("echo $(id)", rules)).toBe("ask");
    expect(await verdict("echo $(id); sudo ls", rules)).toBe("deny");
  });

  it("a pattern's other characters are literal — `?`, `.`, `+` included", async () => {
    const rules = layers([allow("ls a?.txt")]);
    expect(await verdict("ls a?.txt", rules)).toBe("allow");
    expect(await verdict("ls a.txt", rules)).toBe("ask");
    expect(await verdict("ls abtxt", rules)).toBe("ask");
  });
});
