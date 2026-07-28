"""
Document Fetcher for EDK2 Documentation Sources
Fetches documents from tianocore-wiki and tianocore-docs repository
"""

import os
import re
import subprocess
import logging
from typing import List, Dict, Optional
from pathlib import Path
from dataclasses import dataclass
import json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class Document:
    doc_id: str
    title: str
    content: str
    source: str
    url: Optional[str] = None
    metadata: Dict = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
    
    def to_dict(self) -> Dict:
        return {
            "doc_id": self.doc_id,
            "title": self.title,
            "content": self.content,
            "source": self.source,
            "url": self.url,
            "metadata": self.metadata
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "Document":
        return cls(
            doc_id=data["doc_id"],
            title=data["title"],
            content=data["content"],
            source=data["source"],
            url=data.get("url"),
            metadata=data.get("metadata", {})
        )


class DocumentFetcher:
    def __init__(self, config):
        self.config = config
        self.documents: List[Document] = []
    
    def fetch_all(self) -> List[Document]:
        logger.info("Starting document fetch from all sources...")
        
        all_docs = []
        
        if "wiki" in self.config.document_sources:
            wiki_docs = self.fetch_tianocore_wiki()
            all_docs.extend(wiki_docs)
            logger.info(f"Fetched {len(wiki_docs)} documents from tianocore-wiki")
        
        if "docs" in self.config.document_sources:
            docs = self.fetch_tianocore_docs()
            all_docs.extend(docs)
            logger.info(f"Fetched {len(docs)} documents from tianocore-docs")
        
        additional_docs = self.fetch_additional_repos()
        all_docs.extend(additional_docs)
        logger.info(f"Fetched {len(additional_docs)} documents from additional repos")
        
        self.documents = all_docs
        logger.info(f"Total documents fetched: {len(all_docs)}")
        
        return all_docs
    
    def fetch_tianocore_wiki(self) -> List[Document]:
        logger.info("Fetching from tianocore-wiki...")
        
        wiki_path = Path(self.config.wiki_full_path)
        wiki_path.mkdir(parents=True, exist_ok=True)
        
        wiki_api_url = "https://github.com/tianocore/tianocore.github.io/wiki"
        
        try:
            result = subprocess.run(
                ["git", "clone", "--depth=1", 
                 "https://github.com/tianocore/tianocore.github.io.wiki.git",
                 str(wiki_path)],
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode != 0:
                logger.warning(f"Git clone warning: {result.stderr}")
                if "already exists" not in result.stderr:
                    return self._parse_local_wiki(wiki_path)
            
            return self._parse_local_wiki(wiki_path)
            
        except subprocess.TimeoutExpired:
            logger.error("Git clone timed out")
            return []
        except Exception as e:
            logger.error(f"Error fetching wiki: {e}")
            return []
    
    def _parse_local_wiki(self, wiki_path: Path) -> List[Document]:
        documents = []
        
        for md_file in wiki_path.glob("*.md"):
            try:
                content = md_file.read_text(encoding='utf-8')
                title = md_file.stem
                
                doc = Document(
                    doc_id=f"wiki-{md_file.stem}",
                    title=title,
                    content=content,
                    source="tianocore-wiki",
                    url=f"https://github.com/tianocore/tianocore.github.io/wiki/{title}",
                    metadata={
                        "file_path": str(md_file),
                        "file_type": "markdown"
                    }
                )
                documents.append(doc)
            except Exception as e:
                logger.error(f"Error parsing {md_file}: {e}")
        
        return documents
    
    def fetch_tianocore_docs(self) -> List[Document]:
        logger.info("Fetching from tianocore-docs...")
        
        docs_path = Path(self.config.docs_full_path)
        docs_path.mkdir(parents=True, exist_ok=True)
        
        try:
            result = subprocess.run(
                ["git", "clone", "--depth=1",
                 self.config.tianocore_docs_repo,
                 str(docs_path)],
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode != 0:
                logger.warning(f"Git clone warning: {result.stderr}")
                if "already exists" not in result.stderr:
                    return self._parse_local_docs(docs_path)
            
            return self._parse_local_docs(docs_path)
            
        except subprocess.TimeoutExpired:
            logger.error("Git clone timed out")
            return []
        except Exception as e:
            logger.error(f"Error fetching docs: {e}")
            return []
    
    def _parse_local_docs(self, docs_path: Path) -> List[Document]:
        documents = []
        
        for md_file in docs_path.rglob("*.md"):
            try:
                content = md_file.read_text(encoding='utf-8')
                title = md_file.stem
                rel_path = md_file.relative_to(docs_path)
                
                doc = Document(
                    doc_id=f"docs-{str(rel_path).replace(os.sep, '-')}",
                    title=title,
                    content=content,
                    source="tianocore-docs",
                    url=f"https://github.com/tianocore/docs/blob/master/{rel_path}",
                    metadata={
                        "file_path": str(md_file),
                        "file_type": "markdown",
                        "relative_path": str(rel_path)
                    }
                )
                documents.append(doc)
            except Exception as e:
                logger.error(f"Error parsing {md_file}: {e}")
        
        for txt_file in docs_path.rglob("*.txt"):
            try:
                content = txt_file.read_text(encoding='utf-8')
                title = txt_file.stem
                rel_path = txt_file.relative_to(docs_path)
                
                doc = Document(
                    doc_id=f"docs-{str(rel_path).replace(os.sep, '-')}",
                    title=title,
                    content=content,
                    source="tianocore-docs",
                    url=f"https://github.com/tianocore/docs/blob/master/{rel_path}",
                    metadata={
                        "file_path": str(txt_file),
                        "file_type": "text",
                        "relative_path": str(rel_path)
                    }
                )
                documents.append(doc)
            except Exception as e:
                logger.error(f"Error parsing {txt_file}: {e}")
        
        return documents
    
    def fetch_additional_repos(self) -> List[Document]:
        """Fetch documents from additional tianocore-docs repositories"""
        all_docs = []
        
        if not hasattr(self.config, 'additional_repos') or not self.config.additional_repos:
            return all_docs
        
        data_path = Path(self.config.data_directory)
        
        for repo_info in self.config.additional_repos:
            repo_name = repo_info.get("name", "")
            repo_url = repo_info.get("url", "")
            repo_desc = repo_info.get("description", "")
            
            if not repo_name or not repo_url:
                continue
            
            logger.info(f"Fetching from {repo_name} ({repo_desc})...")
            
            repo_path = data_path / repo_name
            
            try:
                if repo_path.exists():
                    logger.info(f"Repository {repo_name} already exists, updating...")
                    result = subprocess.run(
                        ["git", "pull"],
                        cwd=str(repo_path),
                        capture_output=True,
                        text=True,
                        timeout=60
                    )
                else:
                    result = subprocess.run(
                        ["git", "clone", "--depth=1", repo_url, str(repo_path)],
                        capture_output=True,
                        text=True,
                        timeout=300
                    )
                
                if result.returncode != 0 and "already exists" not in result.stderr:
                    logger.warning(f"Git operation warning for {repo_name}: {result.stderr}")
                
                docs = self._parse_repo_content(repo_path, repo_name)
                all_docs.extend(docs)
                logger.info(f"Fetched {len(docs)} documents from {repo_name}")
                
            except subprocess.TimeoutExpired:
                logger.error(f"Git operation timed out for {repo_name}")
            except Exception as e:
                logger.error(f"Error fetching {repo_name}: {e}")
        
        return all_docs
    
    def _parse_repo_content(self, repo_path: Path, repo_name: str) -> List[Document]:
        """Parse all documents from a repository"""
        documents = []
        
        # Parse markdown files
        for md_file in repo_path.rglob("*.md"):
            try:
                content = md_file.read_text(encoding='utf-8')
                title = md_file.stem
                rel_path = md_file.relative_to(repo_path)
                
                doc = Document(
                    doc_id=f"{repo_name}-{str(rel_path).replace(os.sep, '-')}",
                    title=title,
                    content=content,
                    source=repo_name,
                    url=f"https://github.com/tianocore-docs/{repo_name}/blob/main/{rel_path}",
                    metadata={
                        "file_path": str(md_file),
                        "file_type": "markdown",
                        "relative_path": str(rel_path),
                        "repo": repo_name
                    }
                )
                documents.append(doc)
            except Exception as e:
                logger.error(f"Error parsing {md_file}: {e}")
        
        # Parse HTML files (common in tianocore-docs repos)
        for html_file in repo_path.rglob("*.html"):
            try:
                content = html_file.read_text(encoding='utf-8')
                title = html_file.stem
                rel_path = html_file.relative_to(repo_path)
                
                doc = Document(
                    doc_id=f"{repo_name}-{str(rel_path).replace(os.sep, '-')}",
                    title=title,
                    content=content,
                    source=repo_name,
                    url=f"https://github.com/tianocore-docs/{repo_name}/blob/main/{rel_path}",
                    metadata={
                        "file_path": str(html_file),
                        "file_type": "html",
                        "relative_path": str(rel_path),
                        "repo": repo_name
                    }
                )
                documents.append(doc)
            except Exception as e:
                logger.error(f"Error parsing {html_file}: {e}")
        
        return documents
    
    def save_documents(self, output_path: str):
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump([doc.to_dict() for doc in self.documents], 
                     f, indent=2, ensure_ascii=False)
        
        logger.info(f"Saved {len(self.documents)} documents to {output_path}")
    
    def load_documents(self, input_path: str) -> List[Document]:
        input_file = Path(input_path)
        
        if not input_file.exists():
            logger.warning(f"Document file not found: {input_path}")
            return []
        
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        self.documents = [Document.from_dict(doc_data) for doc_data in data]
        logger.info(f"Loaded {len(self.documents)} documents from {input_path}")
        
        return self.documents