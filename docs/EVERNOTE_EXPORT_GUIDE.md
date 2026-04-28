# How to Export Evernote Notebooks

Use this guide before running the importer. The tool reads `.enex` files exported by Evernote. It does not connect to your Evernote account and it does not delete anything from Evernote.

## Export One Notebook

1. Open the Evernote desktop app.
2. Find the notebook in the left sidebar.
3. Right-click the notebook.
4. Choose **Export Notebook...**.
5. Choose **ENEX format (.enex)**.
6. Save the file somewhere easy to find, such as `Documents/Evernote-Export`.

## Export Several Notebooks

Repeat the same process for each notebook you want to move. Put all exported `.enex` files into the same folder.

Example:

```text
Documents/
  Evernote-Export/
    Personal.enex
    Work.enex
    Archive.enex
```

Then preview the folder:

```sh
evernote-to-onenote --batch Documents/Evernote-Export --dry-run
```

## What to Check Before Importing

- The folder contains one `.enex` file per notebook.
- The dry-run note counts roughly match what you expect.
- The dry-run report says no data was sent to Microsoft.
- You are signed into a personal Microsoft account, not a work or school account.

## If Evernote Export Is Missing

Evernote changes menus occasionally. If you cannot find **Export Notebook...**, try:

- Select notes and use **File > Export Notes...**.
- Update the Evernote desktop app.
- Use a desktop version of Evernote rather than the web app.

The importer only needs the exported `.enex` files. It does not matter where you save them as long as you can find the folder path.
