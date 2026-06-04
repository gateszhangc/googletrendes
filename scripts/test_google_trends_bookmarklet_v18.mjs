import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const bookmarkletPath = fileURLToPath(new URL("./google_trends_bookmarklet_v18.js", import.meta.url));
await readFile(bookmarkletPath, "utf8");

const html = `<!doctype html>
<html lang="zh-CN">
<head><title>Google Trends Bookmarklet Test</title></head>
<body>
  <main>mock Google Trends page</main>
  <script>
    window.__bubbledKeys = [];
    window.__bubbledInputs = 0;
    document.addEventListener("keydown", (event) => {
      window.__bubbledKeys.push(event.key);
      if (event.key === "Enter") location.hash = "host-enter-refresh";
    });
    document.addEventListener("input", () => {
      window.__bubbledInputs += 1;
    });
  </script>
</body>
</html>`;

const targetUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const appleScript = `
set targetUrl to "${targetUrl}"
set jsCode to read POSIX file "${bookmarkletPath}"
with timeout of 60 seconds
  tell application "Google Chrome"
    activate
    set w to window 1
    set t to make new tab at end of tabs of w with properties {URL:targetUrl}
    set active tab index of w to (count tabs of w)
    delay 1
    execute t javascript jsCode
    delay 1
    execute t javascript "const g=document.querySelector('#gt_rising_popup_v18 [data-x=geo-count]'); g.focus(); g.select();"
  end tell
  tell application "System Events"
    keystroke "-1"
    key code 36
  end tell
  delay 1
  tell application "Google Chrome"
    execute t javascript "const c=document.querySelector('#gt_rising_popup_v18 [data-x=category-count]'); c.focus(); c.select();"
  end tell
  tell application "System Events"
    keystroke "-1"
    key code 36
  end tell
  delay 1
  tell application "Google Chrome"
    set resultText to execute t javascript "JSON.stringify({url:location.href,hash:location.hash,popup:!!document.querySelector('#gt_rising_popup_v18'),geo:document.querySelector('#gt_rising_popup_v18 [data-x=geo-count]')?.value||null,category:document.querySelector('#gt_rising_popup_v18 [data-x=category-count]')?.value||null,bubbledKeys:window.__bubbledKeys||[],bubbledInputs:window.__bubbledInputs||0})"
  end tell
end timeout
return resultText
`;

const stdout = execFileSync("osascript", ["-e", appleScript], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const result = JSON.parse(stdout.trim());

if (!result.popup) {
  throw new Error("Popup disappeared after geo=-1/category=-1 input");
}
if (result.geo !== "-1" || result.category !== "-1") {
  throw new Error(`Expected geo/category -1/-1, got ${result.geo}/${result.category}`);
}
if (result.hash === "#host-enter-refresh") {
  throw new Error(`Host page refresh/router was triggered: ${result.url}`);
}
if (result.bubbledKeys.length > 0 || result.bubbledInputs !== 0) {
  throw new Error(`Popup events bubbled to host page: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify({
  ok: true,
  case: "geo=-1 category=-1 no host refresh",
  result,
}));
