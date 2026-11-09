"""Build the static website from README.md.

README.md is the single source of truth. Every resource line must look like:

    * [Name](https://example.org) - description
    * [Name](https://example.org) (extra note) - description

Any bullet that doesn't match makes the build fail, so a malformed edit can't
silently drop a link from the site.

Usage: python scripts/build_site.py [--readme README.md] [--out site]
"""

import argparse
import datetime as dt
import html
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "templates" / "index.html"

REPO_URL = "https://github.com/isaranga/Sign-Language-Resources"
# Where the "Suggest a resource" button points. Replace with a Google Form
# (or similar) URL so people without a GitHub account can suggest links.
SUGGEST_URL = f"{REPO_URL}/issues/new"
CRITERIA_URL = f"{REPO_URL}/blob/main/CONTRIBUTING.md"

SKIP_SECTIONS = {"Contents"}

HEADING_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$")
BULLET_RE = re.compile(r"^\*\s+")
ENTRY_RE = re.compile(
    r"^\*\s+\[(?P<name>[^\]]+)\]\((?P<url>https?://[^\s)]+)\)"
    r"(?P<note>(?:\s+\([^)]*\))*)"
    r"\s+[-–]\s+(?P<desc>.+?)\s*$"
)


@dataclass
class Resource:
    name: str
    url: str
    description: str
    note: str = ""

    @property
    def domain(self) -> str:
        host = urlparse(self.url).netloc
        return host.removeprefix("www.")


@dataclass
class Section:
    title: str
    resources: list[Resource] = field(default_factory=list)

    @property
    def slug(self) -> str:
        return re.sub(r"[^\w]+", "-", self.title.lower()).strip("-")

    @property
    def short_label(self) -> str:
        """Label for the filter button, e.g. 'German' for 'German Sign Language (...)'."""
        english = self.title.split("(")[0].strip()
        lowered = english.lower()
        suffix = " sign language"
        if lowered.endswith(suffix):
            return english[: -len(suffix)]
        if lowered == "multilingual dictionaries":
            return "Multilingual"
        if lowered == "general resources":
            return "General"
        return english


class BuildError(Exception):
    pass


def parse_readme(text: str) -> list[Section]:
    sections: list[Section] = []
    current: Section | None = None
    errors: list[str] = []

    for lineno, line in enumerate(text.splitlines(), start=1):
        if m := HEADING_RE.match(line):
            title = m["title"]
            current = None if title in SKIP_SECTIONS else Section(title)
            if current:
                sections.append(current)
            continue
        if current is None or not BULLET_RE.match(line):
            continue
        m = ENTRY_RE.match(line)
        if not m:
            errors.append(f"  line {lineno}: {line.strip()}")
            continue
        current.resources.append(
            Resource(
                name=m["name"].strip(),
                url=m["url"],
                description=m["desc"].strip(),
                note=m["note"].strip(),
            )
        )

    if errors:
        raise BuildError(
            "These README lines don't match '* [Name](url) - description':\n"
            + "\n".join(errors)
        )
    empty = [s.title for s in sections if not s.resources]
    if empty:
        raise BuildError("Sections with no resources: " + ", ".join(empty))
    return sections


def last_updated(readme: Path) -> dt.date:
    """Date of the last commit touching README.md."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", readme.name],
            cwd=readme.parent,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except OSError as exc:
        raise BuildError(f"Couldn't run git to find the last-updated date: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        raise BuildError(f"git log failed for {readme}: {exc.stderr.strip()}") from exc
    if not out:
        raise BuildError(f"{readme} has no commits, so there's no last-updated date.")
    return dt.date.fromisoformat(out)


def e(text: str) -> str:
    return html.escape(text, quote=True)


def render_filters(sections: list[Section]) -> str:
    buttons = ['<button type="button" class="chip" data-filter="all" aria-pressed="true">All</button>']
    for s in sections:
        buttons.append(
            f'<button type="button" class="chip" data-filter="{e(s.slug)}" '
            f'aria-pressed="false" title="{e(s.title)}">{e(s.short_label)}</button>'
        )
    return "\n        ".join(buttons)


def render_card(r: Resource) -> str:
    note = f' <span class="note">{e(r.note)}</span>' if r.note else ""
    search = e(f"{r.name} {r.note} {r.description} {r.domain}".lower())
    return f"""\
          <li class="card" data-search="{search}">
            <a href="{e(r.url)}">
              <span class="card-name">{e(r.name)}</span>{note}
              <span class="card-desc">{e(r.description)}</span>
              <span class="card-domain">{e(r.domain)}</span>
            </a>
          </li>"""


def render_sections(sections: list[Section]) -> str:
    out = []
    for s in sections:
        count = len(s.resources)
        cards = "\n".join(render_card(r) for r in s.resources)
        out.append(f"""\
      <section class="lang" id="{e(s.slug)}" data-section="{e(s.slug)}">
        <h2>{e(s.title)} <span class="count">{count} link{'s' if count != 1 else ''}</span></h2>
        <ul class="cards">
{cards}
        </ul>
      </section>""")
    return "\n".join(out)


def build(readme: Path, out_dir: Path) -> int:
    sections = parse_readme(readme.read_text(encoding="utf-8"))
    total = sum(len(s.resources) for s in sections)
    updated = last_updated(readme)

    page = TEMPLATE.read_text(encoding="utf-8")
    replacements = {
        "{{filters}}": render_filters(sections),
        "{{sections}}": render_sections(sections),
        "{{total}}": str(total),
        "{{language_count}}": str(sum(1 for s in sections if s.short_label not in {"General", "Multilingual"})),
        "{{updated_iso}}": updated.isoformat(),
        "{{updated}}": f"{updated.day} {updated:%B %Y}",
        "{{suggest_url}}": e(SUGGEST_URL),
        "{{criteria_url}}": e(CRITERIA_URL),
        "{{repo_url}}": e(REPO_URL),
    }
    for key, value in replacements.items():
        page = page.replace(key, value)
    if leftover := re.findall(r"\{\{\w+\}\}", page):
        raise BuildError(f"Unfilled template placeholders: {leftover}")

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(page, encoding="utf-8")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--readme", type=Path, default=ROOT / "README.md")
    parser.add_argument("--out", type=Path, default=ROOT / "site")
    args = parser.parse_args()
    try:
        total = build(args.readme, args.out)
    except BuildError as exc:
        sys.exit(f"Build failed.\n{exc}")
    print(f"Built {args.out / 'index.html'} with {total} resources.")


if __name__ == "__main__":
    main()
