"""
Run RAG Service
Main entry point for starting the MCP server
"""

import argparse
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="EDK2 RAG Service with MCP API")
    parser.add_argument(
        "--config",
        type=str,
        default="config.json",
        help="Path to configuration file"
    )
    parser.add_argument(
        "--fetch-docs",
        action="store_true",
        help="Fetch documents before starting server"
    )
    parser.add_argument(
        "--build-index",
        action="store_true",
        help="Build vector index before starting server"
    )
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="Run in stdio mode (for MCP clients like OpenCode)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="localhost",
        help="MCP server host (socket mode only)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="MCP server port (socket mode only)"
    )
    
    args = parser.parse_args()
    
    from rag_service import Config, DocumentFetcher, VectorStore, MCPServer
    
    config_path = Path(args.config)
    if config_path.exists():
        config = Config.from_file(str(config_path))
        logger.info(f"Loaded config from {config_path}")
    else:
        config = Config()
        logger.info("Using default configuration")
    
    if args.host:
        config.mcp_server_host = args.host
    if args.port:
        config.mcp_server_port = args.port
    
    config.ensure_directories()
    
    vector_store = None
    
    if args.fetch_docs:
        logger.info("Fetching documents...")
        fetcher = DocumentFetcher(config)
        documents = fetcher.fetch_all()
        
        if documents:
            fetcher.save_documents(Path(config.data_directory) / "documents.json")
            logger.info(f"Saved {len(documents)} documents")
            
            if args.build_index or True:
                logger.info("Building vector index...")
                vector_store = VectorStore(config)
                vector_store.add_documents(documents)
                vector_store.persist()
                logger.info("Vector index built successfully")
    
    if vector_store is None:
        vector_store = VectorStore(config)
    
    server = MCPServer(config, vector_store)
    
    try:
        if args.stdio:
            server.start_stdio_server()
        else:
            server.start_socket_server()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.stop()


if __name__ == "__main__":
    main()