// The sidebar file tree. Folders load their contents when first expanded.
// It shows either one opened folder's contents, or a list of files and folders dropped onto it.
import { ListDir } from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import { basename, samePath } from './paths';

export type TreeItem = { path: string; isDir: boolean };
type Node = Pick<main.Entry, 'name' | 'path' | 'isDir'>;

export class Tree {
  private roots: TreeItem[] = [];
  private expanded = new Set<string>();
  private active: string | null = null;

  constructor(
    private container: HTMLElement,
    private titleEl: HTMLElement,
    private onOpenFile: (path: string) => void,
  ) {}

  get isEmpty(): boolean {
    return this.roots.length === 0;
  }

  /** Shows one folder's contents, replacing whatever was shown. */
  async setRoot(path: string): Promise<void> {
    this.roots = [{ path, isDir: true }];
    this.expanded.clear();
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
    await this.refresh();
  }

  private async remove(path: string): Promise<void> {
    this.roots = this.roots.filter((r) => r.path !== path);
    await this.refresh();
  }

  private isSingleFolder(): boolean {
    return this.roots.length === 1 && this.roots[0].isDir;
  }

  private showTitle(): void {
    const r = this.roots;
    this.titleEl.textContent =
      r.length === 0 ? 'No folder open' : r.length === 1 ? basename(r[0].path) || r[0].path : `${r.length} items`;
    this.titleEl.title = r.map((x) => x.path).join('\n');
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
    this.showTitle();
    this.container.replaceChildren();
    if (this.roots.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'tree-empty';
      msg.textContent = 'Drop Markdown files or folders here to list them.';
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
    let entries: main.Entry[];
    try {
      entries = await ListDir(dir);
    } catch (e) {
      const msg = document.createElement('div');
      msg.className = 'tree-empty';
      msg.textContent = String(e);
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
    row.className = 'node';
    row.dataset.path = entry.path;
    row.style.paddingLeft = 8 + depth * 14 + 'px';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name;
    label.title = entry.path;
    row.append(twisty, label);
    wrap.appendChild(row);

    if (entry.isDir) {
      const kids = document.createElement('div');
      wrap.appendChild(kids);
      const open = async () => {
        twisty.textContent = '▾';
        kids.replaceChildren();
        await this.fill(kids, entry.path, depth + 1);
        this.setActive(this.active);
      };
      twisty.textContent = '▸';
      if (this.expanded.has(entry.path)) await open();
      row.addEventListener('click', async () => {
        if (this.expanded.has(entry.path)) {
          this.expanded.delete(entry.path);
          twisty.textContent = '▸';
          kids.replaceChildren();
        } else {
          this.expanded.add(entry.path);
          await open();
        }
      });
    } else {
      if (entry.path === this.active) row.classList.add('active');
      row.addEventListener('click', () => this.onOpenFile(entry.path));
    }
    return wrap;
  }
}
