#!/usr/bin/env python3
"""Fetch the UEFI specification sources that init_kb.py ingests.

init_kb.py expects `<DATA_DIR>/uefi-specs/<VERSION>/source/` to contain the
RST sources (and optional PDFs). This script recreates that layout:

  ACPI_6.5   <- git clone https://github.com/UEFI/ACPI-Specification-Release
  PI_1.10    <- git clone https://github.com/UEFI/PI-Specification-Release
  UEFI_2.11  <- git clone https://github.com/UEFI/UEFI-Specification-Release
  Shell_2.2  <- download UEFI_Shell_2_2.pdf from uefi.org

Existing clones are fast-forwarded with `git pull --ff-only`, so re-running
keeps the sources in sync with upstream (useful before an incremental build).

Usage:
    python fetchers/fetch_specs.py
"""

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
KB_DATA = Path(os.environ.get("EDK2_KB_DATA", str(BASE_DIR / "data")))

SHELL_PDF_URLS = [
    "https://uefi.org/sites/default/files/resources/UEFI_Shell_2_2.pdf",
    ("https://web.archive.org/web/20210310034802/http://www.uefi.org/"
     "sites/default/files/resources/UEFI_Shell_2_2.pdf"),
    ("https://web.archive.org/web/2id_/https://uefi.org/sites/default/"
     "files/resources/UEFI_Shell_2_2.pdf"),
]

# name -> (git clone URL, or None if downloaded instead)
SPECS = {
    "ACPI_6.5": ("https://github.com/UEFI/ACPI-Specification-Release.git", None),
    "PI_1.10": ("https://github.com/UEFI/PI-Specification-Release.git", None),
    "UEFI_2.11": ("https://github.com/UEFI/UEFI-Specification-Release.git", None),
    "Shell_2.2": (None, SHELL_PDF_URLS),
}


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r


def fetch_repo(name, url, target):
    if target.exists():
        print(f"[update] {name}: git pull --ff-only")
        try:
            run(["git", "pull", "--ff-only"], cwd=target)
        except RuntimeError as e:
            print(f"  WARN: pull failed ({e}); keeping existing clone")
        return
    print(f"[clone] {name} <- {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", "--depth", "1", url, str(target)])
    print(f"[ok] {name} -> {target}")


def fetch_pdf(name, urls, target, force=False):
    pdf = target / "source" / "UEFI_Shell_2_2.pdf"
    if pdf.exists() and not force:
        print(f"[skip] {name}: PDF already present at {pdf}")
        return True
    pdf.parent.mkdir(parents=True, exist_ok=True)
    for url in urls:
        print(f"[download] {name} <- {url}")
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/120.0 Safari/537.36"),
                "Referer": "https://uefi.org/specifications",
            })
            with urllib.request.urlopen(req, timeout=90) as resp, \
                    open(pdf, "wb") as out:
                shutil.copyfileobj(resp, out)
            if pdf.stat().st_size > 100_000:
                print(f"[ok] {name} -> {pdf}")
                return True
            print(f"  WARN: downloaded file too small "
                  f"({pdf.stat().st_size} B), trying next URL")
            pdf.unlink()
        except Exception as e:
            print(f"  WARN: {url} failed ({type(e).__name__}: {e})")
    print(f"WARN: {name} PDF could not be downloaded from any source; "
          f"the spec will be skipped (drop the PDF manually at {pdf})",
          file=sys.stderr)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="redownload specs even if already present")
    args = ap.parse_args()
    out = KB_DATA / "uefi-specs"
    for name, (repo, pdf_urls) in SPECS.items():
        try:
            if repo:
                fetch_repo(name, repo, out / name)
            else:
                fetch_pdf(name, pdf_urls, out / name, force=args.force)
        except RuntimeError as e:
            print(f"ERROR: {name}: {e}", file=sys.stderr)
            sys.exit(1)
    print(f"Spec sources ready under {out}")


if __name__ == "__main__":
    main()