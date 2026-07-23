@echo off
REM EDK II PR Workflow Test Script - Windows
REM Run all test cases on Windows platform

echo ========================================
echo EDK II PR Workflow Test Suite (Windows)
echo ========================================
echo.

cd /d "%~dp0"

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed
    exit /b 1
)

REM Run tests
echo Running test suite...
echo.
python test_pr_workflow.py

echo.
echo ========================================
echo Test Complete
echo ========================================

pause