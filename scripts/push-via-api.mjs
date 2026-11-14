/** 网络阻断时的推送旁路:经 gh api 的 Git Data API 逐 commit 重建远端历史。 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "yiqiui/memcore";
const GH = "gh";
function api(path, json, method) {
  const methodArg = method ? `-X ${method} ` : "";
  const cmd = `${GH} api ${methodArg}repos/${REPO}/${path} --input -`;
  if (json === undefined) {
    return execSync(`gh api repos/${REPO}/${path}`, {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
    });
  }
  return execSync(cmd, {
    input: JSON.stringify(json),
    encoding: "utf-8",
    maxBuffer: 128 * 1024 * 1024,
  });
}
function sh(cmd) {
  return execSync(cmd, { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 }).trim();
}

const remoteSha = sh("git ls-remote git@github.com:yiqiui/memcore.git main").split(/\s+/)[0];
console.log("remote head:", remoteSha);

const localHead = sh("git rev-parse HEAD");
if (remoteSha === localHead) {
  console.log("already up to date");
  process.exit(0);
}
const commits = sh(`git log --reverse --format=%H ${remoteSha}..HEAD`).split("\n").filter(Boolean);
console.log("local ahead:", commits.length, "commit(s)");

let parent = remoteSha;
for (const c of commits) {
  const message = sh(`git log -1 --format=%B ${c}`);
  const parentTree = JSON.parse(api(`git/commits/${parent}`)).tree.sha;
  // diff 用本地父提交(远程 API commit 对象本地不存在)
  const localParent = sh(`git rev-parse ${c}~1`);
  const changes = sh(`git diff --name-status ${localParent} ${c}`).trim().split("\n").filter(Boolean);
  console.log(`commit ${c.slice(0, 10)}: ${changes.length} file(s)`);

  const treeEntries = [];
  for (const line of changes) {
    const [status, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (status.startsWith("D")) {
      treeEntries.push({ path, sha: null, mode: "100644", type: "blob" });
      continue;
    }
    const blob = JSON.parse(
      api("git/blobs", { content: readFileSync(path).toString("base64"), encoding: "base64" }),
    );
    treeEntries.push({ path, sha: blob.sha, mode: "100644", type: "blob" });
  }

  const tree = JSON.parse(api("git/trees", { base_tree: parentTree, tree: treeEntries }));
  const commit = JSON.parse(
    api("git/commits", { message, tree: tree.sha, parents: [parent] }),
  );
  parent = commit.sha;
  console.log("  →", commit.sha.slice(0, 10));
}

api(`git/refs/heads/main`, { sha: parent }, "PATCH");
console.log("ref updated →", parent.slice(0, 10));
const verify = sh("git ls-remote git@github.com:yiqiui/memcore.git main").split(/\s+/)[0];
console.log("verify:", verify === parent ? "REMOTE SYNCED ✓" : `MISMATCH ${verify}`);
if (verify !== parent) process.exit(1);
