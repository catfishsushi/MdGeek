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
