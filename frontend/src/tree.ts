// The sidebar file tree. Folders load their contents when first expanded.
// It shows either one opened folder's contents, or a list of files and folders dropped onto it.
import { backend, Entry } from './backend';
import { NoAccess } from './backend/errors';
import { basename, isInside, samePath } from './paths';

export type TreeItem = { path: string; isDir: boolean };
type Node = Pick<Entry, 'name' | 'path' | 'isDir'>;

/** The parts of the sidebar, outside the tree itself, that show what is listed. */
export interface TreeChrome {
  sidebar: HTMLElement; // gets the class "has-items" while anything is listed
  title: HTMLElement;
  count: HTMLElement;
  where: HTMLElement;
}

const svg = (cls: string, paths: string) =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const CHEVRON = svg('chev', '<path d="M9 6l6 6-6 6"/>');
const FOLDER_ICON = svg('ic', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const FILE_ICON = svg('ic', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>');

export class Tree {
  private roots: TreeItem[] = [];
  private expanded = new Set<string>();
  private active: string | null = null;

  constructor(
    private container: HTMLElement,
    private chrome: TreeChrome,
    private onOpenFile: (path: string) => void,
    /** Called when the top-level list changes, so it can be remembered for next time. */
    private onRootsChange: (items: TreeItem[]) => void = () => {},
  ) {}

  get isEmpty(): boolean {
    return this.roots.length === 0;
  }

  /** Shows one folder's contents, replacing whatever was shown. */
  async setRoot(path: string): Promise<void> {
    this.roots = [{ path, isDir: true }];
    this.expanded.clear();
    this.onRootsChange(this.roots.slice());
    await this.refresh();
  }

  /**
   * Lists last session's items, ahead of anything already listed. Folders start collapsed, since the
   * browser may need a click to allow access again.
   */
  async restore(items: TreeItem[]): Promise<void> {
    const fresh = items.filter((it) => !this.roots.some((r) => samePath(r.path, it.path)));
    this.roots = [...fresh, ...this.roots];
    await this.refresh();
  }

  /** Lists more files and folders alongside what's already shown. Ones already listed are skipped. */
  async add(items: TreeItem[]): Promise<void> {
    const fresh = items.filter((it) => !this.roots.some((r) => samePath(r.path, it.path)));
    if (fresh.length === 0) return;
    // An opened folder was showing its contents directly. It becomes one entry in the list, kept open.
    if (this.isSingleFolder()) this.expanded.add(this.roots[0].path);
    for (const it of fresh) if (it.isDir) this.expanded.add(it.path);
    this.roots.push(...fresh);
    this.onRootsChange(this.roots.slice());
    await this.refresh();
  }

  /** Empties the pane. Nothing on disk changes. */
  async clear(): Promise<void> {
    this.roots = [];
    this.expanded.clear();
    this.onRootsChange([]);
    await this.refresh();
  }

  /** Whether the path is already in the pane, listed itself or inside a listed folder. */
  shows(path: string): boolean {
    return this.roots.some((r) => (r.isDir ? isInside(path, r.path) : samePath(r.path, path)));
  }

  private async remove(path: string): Promise<void> {
    this.roots = this.roots.filter((r) => r.path !== path);
    this.onRootsChange(this.roots.slice());
    await this.refresh();
  }

  private isSingleFolder(): boolean {
    return this.roots.length === 1 && this.roots[0].isDir;
  }

  /** Header and footer: what is listed, how many files are showing, and where they are. */
  private showChrome(): void {
    const r = this.roots;
    const { sidebar, title, where } = this.chrome;
    sidebar.classList.toggle('has-items', r.length > 0);
    title.textContent =
      r.length === 0 ? 'No folder open' : r.length === 1 ? basename(r[0].path) || r[0].path : `${r.length} items`;
    title.title = r.map((x) => x.path).join('\n');
    where.textContent = r.length === 1 ? r[0].path : '';
    where.title = where.textContent;
    this.updateCount();
  }

  /** Counts the files currently showing; files inside closed folders aren't loaded yet, so aren't counted. */
  private updateCount(): void {
    const n = this.container.querySelectorAll('.node.file').length;
    this.chrome.count.textContent = `${n} file${n === 1 ? '' : 's'} shown`;
  }

  setActive(path: string | null): void {
    this.active = path;
    this.container.querySelectorAll<HTMLElement>('.node.active').forEach((n) => n.classList.remove('active'));
    if (!path) return;
    this.container.querySelectorAll<HTMLElement>('.node[data-path]').forEach((n) => {
      if (n.dataset.path === path) n.classList.add('active');
    });
  }

  async refresh(): Promise<void> {
    this.container.replaceChildren();
    if (this.roots.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'side-empty';
      msg.textContent = 'Open a folder to browse its Markdown files here. You can also drop files and folders on this pane.';
      this.container.appendChild(msg);
    } else if (this.isSingleFolder()) {
      await this.fill(this.container, this.roots[0].path, 0);
    } else {
      for (const r of this.roots) {
        const node = await this.buildNode({ name: basename(r.path) || r.path, path: r.path, isDir: r.isDir }, 0);
        this.addRemoveButton(node.firstElementChild as HTMLElement, r.path);
        this.container.appendChild(node);
      }
    }
    this.showChrome();
  }

  private addRemoveButton(row: HTMLElement, path: string): void {
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = '×';
    btn.title = 'Remove from list (the file stays on disk)';
    btn.setAttribute('aria-label', 'Remove from list');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.remove(path);
    });
    row.appendChild(btn);
  }

  private async fill(parent: HTMLElement, dir: string, depth: number): Promise<void> {
    let entries: Entry[];
    try {
      entries = await backend.listDir(dir);
    } catch (e) {
      const msg = document.createElement('div');
      msg.className = 'tree-empty';
      if (e instanceof NoAccess) {
        // The click is what lets the browser show its "allow access" prompt.
        const ask = document.createElement('button');
        ask.className = 'btn';
        ask.textContent = `Allow access to ${basename(dir) || dir}`;
        ask.addEventListener('click', () => {
          parent.replaceChildren();
          void this.fill(parent, dir, depth).then(() => this.updateCount());
        });
        msg.append(ask);
      } else {
        msg.textContent = String(e);
      }
      parent.appendChild(msg);
      return;
    }
    if (entries.length === 0 && depth === 0) {
      const msg = document.createElement('div');
      msg.className = 'tree-empty';
      msg.textContent = 'No Markdown files here.';
      parent.appendChild(msg);
      return;
    }
    for (const entry of entries) {
      parent.appendChild(await this.buildNode(entry, depth));
    }
  }

  private async buildNode(entry: Node, depth: number): Promise<HTMLElement> {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'node ' + (entry.isDir ? 'dir' : 'file');
    row.dataset.path = entry.path;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    // Files line up with folder icons: they have no arrow (14px) or the gap after it (8px).
    row.style.paddingLeft = 8 + depth * 18 + (entry.isDir ? 0 : 22) + 'px';
    const ext = entry.isDir ? '' : (/\.[^.]+$/.exec(entry.name)?.[0] ?? '');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = ext ? entry.name.slice(0, -ext.length) : entry.name;
    label.title = entry.path;
    row.insertAdjacentHTML('beforeend', entry.isDir ? CHEVRON + FOLDER_ICON : FILE_ICON);
    row.append(label);
    if (ext) {
      const tag = document.createElement('span');
      tag.className = 'ext';
      tag.textContent = ext.toLowerCase();
      row.append(tag);
    }
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        row.click();
      }
    });
    wrap.appendChild(row);

    if (entry.isDir) {
      const kids = document.createElement('div');
      wrap.appendChild(kids);
      const setOpen = (open: boolean) => {
        row.classList.toggle('open', open);
        row.setAttribute('aria-expanded', String(open));
      };
      const open = async () => {
        setOpen(true);
        kids.replaceChildren();
        await this.fill(kids, entry.path, depth + 1);
        this.setActive(this.active);
      };
      setOpen(false);
      if (this.expanded.has(entry.path)) await open();
      row.addEventListener('click', async () => {
        if (this.expanded.has(entry.path)) {
          this.expanded.delete(entry.path);
          setOpen(false);
          kids.replaceChildren();
        } else {
          this.expanded.add(entry.path);
          await open();
        }
        this.updateCount();
      });
    } else {
      if (entry.path === this.active) row.classList.add('active');
      row.addEventListener('click', () => this.onOpenFile(entry.path));
    }
    return wrap;
  }
}
