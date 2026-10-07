/**
 * The browser needs the user's OK before MdGeek can save this file, and it only asks right after a
 * click. Thrown when a save (usually autosave) runs without one; the page then shows an Allow button.
 */
export class NeedsPermission extends Error {
  constructor() {
    super('MdGeek needs permission to save here');
    this.name = 'NeedsPermission';
  }
}

/**
 * The browser hasn't given MdGeek access to this file or folder in this session (it forgets between
 * sessions unless the user chose "Allow on every visit"). Asking needs a click, so the left pane shows
 * an "Allow access" button instead.
 */
export class NoAccess extends Error {
  constructor(name: string) {
    super(`MdGeek doesn't have access to ${name} yet`);
    this.name = 'NoAccess';
  }
}
