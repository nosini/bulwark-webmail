let counter = 0;

export interface MailvelopeHost {
  /** CSS selector Mailvelope resolves to inject its iframe. */
  selector: string;
  /** Removes the host. A late injection then finds no element and is a no-op. */
  dispose: () => void;
}

/**
 * Mailvelope containers are mounted by CSS selector and there is no way to
 * tear one down. Give every mount its own uniquely-named child of `container`
 * and drop it on cleanup, so a slow injection from an effect that has already
 * been cleaned up (fast message switching, StrictMode's double effect) cannot
 * end up as a second iframe next to the live one.
 *
 * Its iframe is `width: 100%; height: 100%`, so `container` needs a real height.
 */
export function createMailvelopeHost(container: HTMLElement): MailvelopeHost {
  const el = document.createElement('div');
  el.id = `mailvelope-host-${++counter}`;
  el.style.width = '100%';
  el.style.height = '100%';
  container.appendChild(el);
  return { selector: `#${el.id}`, dispose: () => el.remove() };
}
