#!/bin/bash
# EDK II PR Workflow Test Script - Linux
# Run all test cases on Linux platform

echo "========================================"
echo "EDK II PR Workflow Test Suite (Linux)"
echo "========================================"
echo

cd "$(dirname "$0")/.."

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python3 is not installed"
    exit 1
fi

# Run tests
echo "Running test suite..."
echo
python3 test_pr_workflow.py

echo
echo "========================================"
echo "Test Complete"
echo "========================================"