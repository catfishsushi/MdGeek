// The sidebar file tree. Folders load their contents when first expanded.
import { ListDir } from '../wailsjs/go/main/App';
import { main } from '../wailsjs/go/models';
import { basename } from './paths';

export class Tree {
  private root: string | null = null;
  private expanded = new Set<string>();
  private active: string | null = null;

  constructor(
    private container: HTMLElement,
    private titleEl: HTMLElement,
    private onOpenFile: (path: string) => void,
  ) {}

  get rootPath(): string | null {
    return this.root;
  }

  async setRoot(path: string): Promise<void> {
    this.root = path;
    this.expanded.clear();
    this.titleEl.textContent = basename(path) || path;
    this.titleEl.title = path;
    await this.refresh();
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
    if (!this.root) return;
    await this.fill(this.container, this.root, 0);
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

  private async buildNode(entry: main.Entry, depth: number): Promise<HTMLElement> {
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
