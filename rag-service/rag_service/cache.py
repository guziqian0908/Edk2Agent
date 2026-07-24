"""Memory Cache for RAG queries"""

import time
from typing import Dict, Any, Optional
from collections import OrderedDict
import hashlib

class MemoryCache:
    def __init__(self, max_size: int = 100, ttl_seconds: int = 3600):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0
        }
    
    def _hash_key(self, query: str, top_k: int) -> str:
        content = f"{query}:{top_k}"
        return hashlib.md5(content.encode()).hexdigest()
    
    def get(self, query: str, top_k: int = 5) -> Optional[Any]:
        key = self._hash_key(query, top_k)
        
        if key in self._cache:
            entry = self._cache[key]
            
            if time.time() - entry["timestamp"] < self.ttl_seconds:
                self._cache.move_to_end(key)
                self._stats["hits"] += 1
                return entry["data"]
            else:
                del self._cache[key]
        
        self._stats["misses"] += 1
        return None
    
    def set(self, query: str, top_k: int, data: Any):
        key = self._hash_key(query, top_k)
        
        if key in self._cache:
            del self._cache[key]
        
        if len(self._cache) >= self.max_size:
            self._cache.popitem(last=False)
            self._stats["evictions"] += 1
        
        self._cache[key] = {
            "data": data,
            "timestamp": time.time()
        }
    
    def clear(self):
        self._cache.clear()
    
    def get_stats(self) -> Dict[str, Any]:
        total = self._stats["hits"] + self._stats["misses"]
        hit_rate = (self._stats["hits"] / total * 100) if total > 0 else 0
        
        return {
            **self._stats,
            "size": len(self._cache),
            "max_size": self.max_size,
            "hit_rate": f"{hit_rate:.1f}%"
        }

CACHE = MemoryCache()

def get_cache() -> MemoryCache:
    return CACHE