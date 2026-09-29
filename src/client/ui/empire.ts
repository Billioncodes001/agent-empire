import { keyLabel } from '../controls';
import { FLOOR_RISE } from '../../shared/layout';
import { SITES, type SiteId } from '../../shared/empire';
import { entranceAccess, entrance, worldPosition, mapPoint, mapWorld } from '../navigation';
import { store } from '../state';
import type { Net } from '../net';
import type { PlayerController } from '../player';
import { h, openModal, toast } from './dom';
import { openManagement } from './management';
import { mountTouchControls } from './touch';
import { mountGameMenu } from './game-menu';

export function mountEmpire(
  net: Net,
  player: PlayerController,
  research: () => void,
  onInteract?: () => void,
  changeView?: () => void,
  openTerminal?: (workerId: string) => void,
) {
  const map = h('canvas.radar-canvas', { width: 320, height: 320 });
  const place = h('span.radar-place', {}, 'Headquarters');
  const stats = h('span.radar-stats');
  const mapButton = h(
    'button.radar-open',
    { 'aria-label': 'Expand district map', title: 'Expand map' },
    map,
    h('span.radar-north', {}, 'N'),
  );
  const panel = h('nav.radar', { 'aria-label': 'Minimap' }, mapButton, place, stats);
  mapButton.onclick = () => openMap();
  const management = h(
    'button.btn',
    {
      id: 'btn-management',
      title: 'Sector reports and construction',
      onclick: () => openOperations(),
    },
    'Management',
  );
  document.querySelector('.topbar .controls')?.append(management);
  document.getElementById('hud')!.append(panel);
  // Landscape touch controls (joystick, Jump / Use / View) and the game menu, which also lists tools a phone layout hides.
  mountTouchControls({ player, interact: () => (onInteract ? onInteract() : interact()), changeView: () => changeView?.() });
  mountGameMenu({ player, openMap: () => openMap(), openOperations: () => openOperations() });
  let waypoint: { x: number; z: number; name: string } | null = null;
  let fullMap: HTMLCanvasElement | null = null;
  function openMap() {
    const canvas = h('canvas.district-map', {
      width: 1000,
      height: 760,
      'aria-label': 'District map. Select a location below to set a waypoint.',
    });
    fullMap = canvas;
    const close = h('button.btn', { 'aria-label': 'Close district map' }, 'Close');
    const details = h('div.map-locations');
    const note = h('p.map-note', {}, 'Select a destination to mark it on your minimap. Walk or drive there.');
    const renderLocations = () =>
      details.replaceChildren(
        ...SITES.map((site) => {
          const access = entranceAccess(site.id, store.empire, store.workers.values());
          return h(
            'article.map-location',
            {},
            h('div', {}, h('strong', {}, site.name), h('small', {}, access.reason)),
            h(
              'button.btn',
              {
                'aria-label': `Set waypoint to ${site.name}`,
                onclick: () => {
                  waypoint = { ...entrance(site.id), name: site.name };
                  note.textContent = `Waypoint set: ${site.name}`;
                  draw(canvas, false);
                },
              },
              'Set waypoint',
            ),
            h(
              'button.btn',
              {
                'aria-label': `Manage ${site.name}`,
                onclick: () => openOperations(site.id),
              },
              'Manage',
            ),
          );
        }),
      );
    const off = store.on('empire', renderLocations),
      offWorkers = store.on('workers', renderLocations);
    const modal = openModal(
      h(
        'div.modal.map-modal',
        { role: 'dialog', 'aria-label': 'District map' },
        h('header', {}, h('div', {}, h('small', {}, 'WATERFRONT'), h('h2', {}, 'District map')), close),
        h('div.map-layout', {}, canvas, details),
        note,
        h(
          'button.btn',
          {
            onclick: () => {
              waypoint = null;
              note.textContent = 'Waypoint cleared.';
              draw(canvas, false);
            },
          },
          'Clear waypoint',
        ),
      ),
      {
        onClose: () => {
          fullMap = null;
          off();
          offWorkers();
        },
      },
    );
    close.onclick = () => modal.close();
    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      waypoint = {
        ...mapWorld(((e.clientX - r.left) / r.width) * 1000, ((e.clientY - r.top) / r.height) * 760, 1000, 760),
        name: 'Custom waypoint',
      };
      note.textContent = 'Custom waypoint set';
      draw(canvas, false);
    };
    renderLocations();
    draw(canvas, false);
  }
  function draw(canvas: HTMLCanvasElement, mini: boolean) {
    const c = canvas.getContext('2d')!,
      w = canvas.width,
      height = canvas.height;
    const pos = worldPosition(player.pos.x, player.pos.z);
    const scale = mini ? 3.1 : 1;
    const to = (x: number, z: number) =>
      mini
        ? {
            x: w / 2 + (x - pos.x) * scale,
            y: height / 2 + (z - pos.z) * scale,
          }
        : mapPoint(x, z, w, height);
    c.clearRect(0, 0, w, height);
    c.fillStyle = '#132f39';
    c.fillRect(0, 0, w, height);
    const rect = (x: number, z: number, rw: number, rh: number, color: string) => {
      const a = to(x, z),
        b = to(x + rw, z + rh);
      c.fillStyle = color;
      c.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    };
    rect(-55, 0, 145, 190, '#263131');
    rect(-53, 22, 7, 120, '#546260');
    rect(-7.5, 0, 15, 190, '#788484');
    for (const z of [62, 90, 118, 146]) rect(-50, z - 5, 106, 10, '#788484');
    for (const x of [-9.4, 9.4]) rect(x - 1.6, 22, 3.2, 112, '#434e4c');
    for (const site of SITES) {
      const access = entranceAccess(site.id, store.empire, store.workers.values());
      rect(site.x - 9, site.z - 6, 18, 12, access.allowed ? '#a9b6ac' : '#52625c');
      const p = to(site.x, site.z);
      c.fillStyle = access.allowed ? '#e3f4de' : '#c0926a';
      c.font = mini ? 'bold 16px system-ui' : 'bold 19px system-ui';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(
        (
          {
            hq: 'H',
            home: '⌂',
            hospital: '+',
            school: 'S',
            cafe: 'C',
            utilities: 'E',
            recreation: 'R',
            studio: 'I',
          } as const
        )[site.id],
        p.x,
        p.y,
      );
      if (!mini) {
        c.font = '14px system-ui';
        c.fillStyle = '#d5ddd6';
        c.fillText(site.name, p.x, p.y + 57);
      }
    }
    if (waypoint) {
      const a = to(pos.x, pos.z),
        b = to(waypoint.x, waypoint.z);
      c.strokeStyle = '#d8b977';
      c.lineWidth = mini ? 2 : 3;
      c.setLineDash([5, 5]);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      c.setLineDash([]);
      const x = mini ? Math.max(18, Math.min(w - 18, b.x)) : b.x,
        y = mini ? Math.max(18, Math.min(height - 18, b.y)) : b.y;
      c.fillStyle = '#e8c278';
      c.beginPath();
      c.arc(x, y, mini ? 7 : 9, 0, Math.PI * 2);
      c.fill();
    }
    const p = to(pos.x, pos.z);
    c.save();
    c.translate(p.x, p.y);
    c.rotate(-player.facing);
    c.fillStyle = '#fafaf4';
    c.strokeStyle = '#101d24';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, 10);
    c.lineTo(-7, -7);
    c.lineTo(0, -3);
    c.lineTo(7, -7);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }
  let needs = { energy: 90, nourishment: 85 };
  try {
    const saved = JSON.parse(localStorage.getItem('agent-empire.needs') ?? 'null');
    if (saved && Number.isFinite(saved.energy) && Number.isFinite(saved.nourishment))
      needs = {
        energy: Math.max(0, Math.min(100, saved.energy)),
        nourishment: Math.max(0, Math.min(100, saved.nourishment)),
      };
  } catch {}
  function openOperations(selected?: SiteId) {
    return openManagement(net, { openQueue: research, openTerminal: (id) => openTerminal?.(id), assignTask }, selected);
  }
  function assignTask(id: SiteId) {
    const site = SITES.find((s) => s.id === id)!;
    const input = h('textarea', {
      rows: 5,
      'aria-label': 'Sector task',
      placeholder: `Describe real research or coding work for ${site.name}…`,
    });
    const close = h('button.btn', {}, 'Cancel');
    const submit = h('button.btn.primary', {}, 'Send to real worker queue');
    const modal = openModal(
      h(
        'div.modal',
        { role: 'dialog', 'aria-label': 'Assign sector task' },
        h('header', {}, h('h2', {}, `AI work / ${site.sector}`), close),
        h(
          'div.body',
          {},
          h('p', {}, 'This runs an actual agent in the connected project and uses your configured AI account.'),
          input,
          submit,
        ),
      ),
    );
    close.onclick = () => modal.close();
    submit.onclick = () => {
      const prompt = input.value.trim();
      if (!prompt) {
        input.focus();
        return;
      }
      net.send({
        t: 'queue.add',
        title: `[${site.sector}] ${prompt.slice(0, 90)}`,
        prompt: `Sector: ${site.sector} / ${site.name}\n\n${prompt}`,
      });
      modal.close();
    };
    input.focus();
  }
  function interact() {
    if (player.pos.z < 30) return false;
    const site = SITES.find((s) => Math.abs(s.x - player.pos.x) < 8.5 && Math.abs(s.z - player.pos.z) < 5.8);
    if (!site || !entranceAccess(site.id, store.empire, store.workers.values()).allowed) return false;
    if (site.id === 'home' || site.id === 'cafe') {
      const close = h('button.btn', {}, 'Close');
      const modal = openModal(
        h(
          'div.modal',
          { role: 'dialog', 'aria-label': site.name },
          h('header', {}, h('h2', {}, site.name), close),
          h(
            'div.body',
            {},
            h('p', {}, `Energy ${Math.round(needs.energy)}% · Nourishment ${Math.round(needs.nourishment)}%`),
            h(
              'button.btn',
              {
                onclick: () => {
                  needs.nourishment = 100;
                  saveNeeds();
                  modal.close();
                  toast('Meal enjoyed. Nourishment restored.', 'info');
                },
              },
              'Have a meal',
            ),
            site.id === 'home'
              ? h(
                  'button.btn',
                  {
                    onclick: () => {
                      needs.energy = 100;
                      saveNeeds();
                      modal.close();
                      toast('Rested at home. Energy restored.', 'info');
                    },
                  },
                  'Rest',
                )
              : null,
            site.id === 'home'
              ? h(
                  'button.btn.primary',
                  {
                    onclick: () => {
                      modal.close();
                      research();
                    },
                  },
                  'Use research computer',
                )
              : null,
            h(
              'button.btn',
              {
                onclick: () => {
                  modal.close();
                  openOperations(site.id);
                },
              },
              'Manage building',
            ),
          ),
        ),
      );
      close.onclick = () => modal.close();
      return true;
    }
    openOperations(site.id);
    return true;
  }
  function saveNeeds() {
    try {
      localStorage.setItem('agent-empire.needs', JSON.stringify(needs));
    } catch {}
  }
  let elapsed = 0;
  return {
    openOperations,
    openMap,
    interact,
    update(dt: number) {
      elapsed += dt;
      if (elapsed < 0.1) return;
      needs.energy = Math.max(0, needs.energy - elapsed * 0.015);
      needs.nourishment = Math.max(0, needs.nourishment - elapsed * 0.02);
      elapsed = 0;
      const pos = worldPosition(player.pos.x, player.pos.z);
      const near = SITES.find((site) => Math.abs(site.x - pos.x) < 10 && Math.abs(site.z - pos.z) < 8);
      place.textContent = waypoint
        ? `${waypoint.name} · ${Math.round(Math.hypot(waypoint.x - pos.x, waypoint.z - pos.z))} m`
        : player.pos.z < 30
          ? `Headquarters · Floor ${Math.floor(player.pos.y / FLOOR_RISE) + 1}`
          : (near?.name ?? 'Waterfront avenue');
      stats.textContent = `${keyLabel(player.bindings.map)} Map · ${keyLabel(player.bindings.camera)} View`;
      draw(map, true);
      if (fullMap) draw(fullMap, false);
    },
  };
}
