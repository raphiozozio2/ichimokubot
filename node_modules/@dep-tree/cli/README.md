# node-dep-tree

Node wrapper for [dep-tree](https://github.com/gabotechs/dep-tree).

## Install

Add `@dep-tree/cli` as a dev dependency.

```shell
yarn add -D @dep-tree/cli
```
or
```shell
npm install --save-dev @dep-tree/cli
```

## Usage

The `dep-tree` binary will be available for checking and rendering dependency trees in your project.

```json
{
  "name": "my-package",
  "scripts": {
    "deps": "dep-tree check"
  }
}
```
