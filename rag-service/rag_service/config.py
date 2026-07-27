"""
Configuration for RAG Service
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional
import json


@dataclass
class Config:
    persist_directory: str = "./chroma_db"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    chunk_size: int = 1024
    chunk_overlap: int = 200
    top_k_results: int = 5
    mcp_server_host: str = "localhost"
    mcp_server_port: int = 8080
    
    tianocore_wiki_url: str = "https://github.com/tianocore/tianocore.github.io/wiki"
    tianocore_docs_repo: str = "https://github.com/tianocore/docs"
    
    data_directory: str = "./data"
    wiki_output_dir: str = "wiki"
    docs_output_dir: str = "docs"
    
    document_sources: List[str] = field(default_factory=lambda: ["wiki", "docs"])
    
    @classmethod
    def from_file(cls, config_path: str) -> "Config":
        with open(config_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return cls(**data)
    
    def to_file(self, config_path: str):
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(self.__dict__, f, indent=2, ensure_ascii=False)
    
    @property
    def wiki_full_path(self) -> str:
        return os.path.join(self.data_directory, self.wiki_output_dir)
    
    @property
    def docs_full_path(self) -> str:
        return os.path.join(self.data_directory, self.docs_output_dir)
    
    def ensure_directories(self):
        os.makedirs(self.data_directory, exist_ok=True)
        os.makedirs(self.wiki_full_path, exist_ok=True)
        os.makedirs(self.docs_full_path, exist_ok=True)
        os.makedirs(self.persist_directory, exist_ok=True)