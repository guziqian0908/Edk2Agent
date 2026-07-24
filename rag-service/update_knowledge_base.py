"""Update Knowledge Base Script

Usage:
    python update_knowledge_base.py [--force]

Options:
    --force    Force update even if documents exist
"""

import subprocess
import sys
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def run_command(cmd, cwd=None):
    logger.info(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    
    if result.returncode != 0:
        logger.error(f"Command failed: {result.stderr}")
        return False
    return True


def update_wiki(wiki_dir: Path, force: bool = False):
    if wiki_dir.exists() and not force:
        logger.info("Updating existing wiki repository...")
        return run_command(["git", "pull"], cwd=wiki_dir)
    else:
        logger.info("Cloning fresh wiki repository...")
        if wiki_dir.exists():
            import shutil
            shutil.rmtree(wiki_dir)
        
        return run_command([
            "git", "clone", "--depth", "1",
            "https://github.com/tianocore/tianocore.github.io.git",
            str(wiki_dir)
        ])


def update_docs(docs_dir: Path, force: bool = False):
    if docs_dir.exists() and not force:
        logger.info("Updating existing docs repository...")
        return run_command(["git", "pull"], cwd=docs_dir)
    else:
        logger.info("Cloning fresh docs repository...")
        if docs_dir.exists():
            import shutil
            shutil.rmtree(docs_dir)
        
        return run_command([
            "git", "clone", "--depth", "1",
            "https://github.com/tianocore/docs.git",
            str(docs_dir)
        ])


def rebuild_index(rag_service_dir: Path):
    logger.info("Rebuilding vector index...")
    
    python_cmd = "python" if sys.platform == "win32" else "python3"
    
    return run_command([
        python_cmd, "run_server.py",
        "--fetch-docs", "--build-index"
    ], cwd=rag_service_dir)


def main():
    force = "--force" in sys.argv
    
    script_dir = Path(__file__).parent
    rag_service_dir = script_dir.parent
    data_dir = rag_service_dir / "data"
    
    data_dir.mkdir(parents=True, exist_ok=True)
    
    wiki_dir = data_dir / "tianocore-wiki"
    docs_dir = data_dir / "tianocore-docs"
    
    logger.info("=" * 50)
    logger.info("EDK2 Knowledge Base Update")
    logger.info("=" * 50)
    
    if not update_wiki(wiki_dir, force):
        logger.error("Failed to update wiki")
        sys.exit(1)
    
    if not update_docs(docs_dir, force):
        logger.error("Failed to update docs")
        sys.exit(1)
    
    if not rebuild_index(rag_service_dir):
        logger.error("Failed to rebuild index")
        sys.exit(1)
    
    logger.info("=" * 50)
    logger.info("Knowledge base updated successfully!")
    logger.info("=" * 50)


if __name__ == "__main__":
    main()