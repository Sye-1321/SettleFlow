import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function checkMarkdownLinks(root, files) {
  const failures = [];
  for (const relativeFile of files.filter((file) => file.endsWith('.md')).sort()) {
    const absoluteFile = resolve(root, relativeFile);
    const markdown = readFileSync(absoluteFile, 'utf8');
    for (const target of markdownTargets(markdown)) {
      if (isExternal(target)) continue;
      const [pathPart = '', fragment] = target.split('#', 2);
      const decodedPath = decodeURIComponent(pathPart.replace(/^<|>$/gu, ''));
      const targetFile =
        decodedPath.length === 0 ? absoluteFile : resolve(dirname(absoluteFile), decodedPath);
      if (!existsSync(targetFile)) {
        failures.push(`${relativeFile}: missing local target ${target}`);
        continue;
      }
      if (
        fragment !== undefined &&
        fragment.length > 0 &&
        extname(targetFile).toLowerCase() === '.md'
      ) {
        const anchors = markdownAnchors(readFileSync(targetFile, 'utf8'));
        if (!anchors.has(decodeURIComponent(fragment).toLowerCase())) {
          failures.push(
            `${relativeFile}: missing anchor #${fragment} in ${decodedPath || relativeFile}`,
          );
        }
      }
    }
  }
  return failures;
}

export function markdownAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of withoutFencedCode(markdown).split(/\r?\n/u)) {
    const explicit = line.match(/<(?:a\s+(?:name|id)|[^>]+\sid)=["']([^"']+)["']/iu)?.[1];
    if (explicit !== undefined) anchors.add(explicit.toLowerCase());
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (heading === undefined) continue;
    const base = githubSlug(heading);
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return anchors;
}

export function markdownTargets(markdown) {
  const targets = [];
  const content = withoutFencedCode(markdown);
  const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;
  for (const match of content.matchAll(linkPattern)) {
    if (match[1] !== undefined) targets.push(match[1]);
  }
  return targets;
}

function githubSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]*>/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

function isExternal(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function withoutFencedCode(markdown) {
  let fenced = false;
  return markdown
    .split(/\r?\n/u)
    .map((line) => {
      if (/^\s*(```|~~~)/u.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function repositoryFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd();
  const failures = checkMarkdownLinks(root, repositoryFiles(root));
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Local Markdown links and anchors are valid.\n');
  }
}
