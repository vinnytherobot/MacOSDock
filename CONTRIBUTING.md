# Contributing to MacOS Dock

Thank you for considering contributing to MacOS Dock. This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Open a new issue with a clear title and description
3. Include your GNOME Shell version and distribution
4. Provide steps to reproduce the issue

### Suggesting Features

1. Open an issue with the "feature request" label
2. Describe the feature and its use case
3. Explain how it aligns with the project's goals

### Submitting Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the coding standards
4. Test your changes thoroughly
5. Submit a pull request

## Development Setup

```bash
git clone https://github.com/vinnytherobot/MacOSDock.git
cd MacOSDock
npm install
npm run build
```

## Coding Standards

- Use TypeScript with strict type checking
- Follow the existing code style and patterns
- Add comments only when necessary for clarity
- Keep functions focused and concise
- Write descriptive commit messages

## Commit Messages

Use conventional commit messages:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `style:` for code style changes
- `refactor:` for code refactoring
- `test:` for adding tests
- `chore:` for maintenance tasks

## Pull Request Process

1. Update documentation if needed
2. Ensure the build passes without errors
3. Request a review from maintainers
4. Address review feedback promptly

## Testing

Before submitting:

1. Run `npm run build` to verify no TypeScript errors
2. Install and test the extension in GNOME Shell
3. Verify all settings work correctly
4. Test on different screen sizes if applicable

## Questions?

Open an issue for any questions about contributing.
