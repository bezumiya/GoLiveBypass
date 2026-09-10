import { renderProtonCountryFlag } from './proton-flags';


export interface ProtonRouteOption {
  value: string;
  label: string;
  description: string;
  countryCode?: string;
  pingMs?: number;
  recommended?: boolean;
  disabled?: boolean;
}

const EMPTY_ROUTE_OPTION: ProtonRouteOption = {
  value: '',
  label: 'Nenhuma rota com ping',
  description: 'Nenhuma rota respondeu à medição',
};

const LOADING_ROUTE_OPTION: ProtonRouteOption = {
  value: '',
  label: 'Buscando rotas…',
  description: 'Medindo o ping das rotas Proton',
};

const ROUTE_LOADING_PLACEHOLDERS = 5;

export type ProtonRouteSelectChange = (value: string) => void;
export type ProtonRouteSelectOpenChange = (open: boolean) => void;


function formatPing(pingMs?: number): string {
  return Number.isFinite(pingMs) && pingMs! > 0 && pingMs! < 999
    ? `${pingMs} ms`
    : '—';
}

function pingClass(pingMs?: number): string {
  if (!Number.isFinite(pingMs) || pingMs! <= 0 || pingMs! >= 999) {
    return ' proton-route-select__ping--unknown';
  }
  if (pingMs! > 180) return ' proton-route-select__ping--high';
  return '';
}

function createSvgIcon(path: string, className: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.8');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.className.baseVal = className;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = path;
  return icon;
}

function createPingBadge(option: ProtonRouteOption, compact = false): HTMLSpanElement {
  const ping = document.createElement('span');
  ping.className = `proton-route-select__ping${pingClass(option.pingMs)}`;
  ping.setAttribute(
    'aria-label',
    Number.isFinite(option.pingMs) && option.pingMs! > 0 && option.pingMs! < 999
      ? `Ping ${formatPing(option.pingMs)}`
      : 'Ping não medido',
  );
  if (!compact && Number.isFinite(option.pingMs) && option.pingMs! > 0 && option.pingMs! < 999) {
    ping.appendChild(createSvgIcon('<path d="M3 18h18M5 15v-2M9 15V9M13 15V5M17 15v-3"/>', 'proton-route-select__ping-icon'));
  }
  const label = document.createElement('span');
  label.textContent = formatPing(option.pingMs);
  ping.appendChild(label);
  return ping;
}

function createFlag(countryCode?: string, className = 'proton-route-select__flag'): HTMLSpanElement {
  const flag = document.createElement('span');
  flag.className = className;
  flag.setAttribute('aria-hidden', 'true');
  if (countryCode) flag.innerHTML = renderProtonCountryFlag(countryCode);
  return flag;
}

export class ProtonRouteSelect {
  private readonly root: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly triggerLabel: HTMLSpanElement;
  private readonly triggerDescription: HTMLSpanElement;
  private triggerFlag: HTMLSpanElement;
  private triggerPing: HTMLSpanElement;
  private measuredRoutes: ProtonRouteOption[] = [];
  private selectedValue = '';
  private highlightedIndex = -1;
  private openState = false;
  private loadingState = false;
  private disabledState = false;
  private changeHandler: ProtonRouteSelectChange | undefined;
  private readonly openChangeHandler: ProtonRouteSelectOpenChange | undefined;
  private optionIdSequence = 0;
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.root.contains(event.target as Node)) this.close(false);
  };

  constructor(root: HTMLElement, openChangeHandler?: ProtonRouteSelectOpenChange) {
    this.openChangeHandler = openChangeHandler;
    this.root = root;

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'proton-route-select__trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-label', 'Escolha uma rota Proton');

    const triggerMain = document.createElement('span');
    triggerMain.className = 'proton-route-select__trigger-main';
    this.triggerFlag = createFlag();
    const triggerCopy = document.createElement('span');
    triggerCopy.className = 'proton-route-select__trigger-copy';
    this.triggerLabel = document.createElement('span');
    this.triggerLabel.className = 'proton-route-select__trigger-label';
    this.triggerDescription = document.createElement('span');
    this.triggerDescription.className = 'proton-route-select__trigger-description';
    triggerCopy.append(this.triggerLabel, this.triggerDescription);
    this.triggerPing = document.createElement('span');
    triggerMain.append(this.triggerFlag, triggerCopy, this.triggerPing);
    const triggerChevron = createSvgIcon('<path d="m6 9 6 6 6-6"/>', 'proton-route-select__chevron');
    this.trigger.append(triggerMain, triggerChevron);
    this.menu = document.createElement('div');
    this.menu.className = 'proton-route-select__menu';
    this.menu.hidden = true;
    this.menu.id = `${root.id || 'protonRouteSelect'}Menu`;
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('aria-label', 'Rotas Proton disponíveis');

    this.trigger.setAttribute('aria-controls', this.menu.id);
    this.root.replaceChildren(this.trigger, this.menu);
    this.trigger.addEventListener('click', () => this.toggle());
    this.trigger.addEventListener('keydown', (event) => this.handleKeyDown(event));
    this.menu.addEventListener('click', (event) => {
      const option = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-route-value]');
      if (!option || option.disabled) return;
      this.choose(option.dataset.routeValue || '');
    });
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    this.render();
  }

  setOnChange(handler: ProtonRouteSelectChange | undefined): void {
    this.changeHandler = handler;
  }

  setMeasuredRoutes(routes: readonly ProtonRouteOption[]): void {
    this.measuredRoutes = routes.map((route) => ({ ...route }));
    this.render();
  }

  setLoading(loading: boolean): void {
    this.loadingState = loading;
    this.root.classList.toggle('is-loading', loading);
    this.root.setAttribute('aria-busy', String(loading));
    this.trigger.setAttribute('aria-busy', String(loading));
    this.menu.setAttribute('aria-busy', String(loading));
    this.render();
  }

  setValue(value: string): void {
    const available = this.allOptions().some((option) => option.value === value);
    this.selectedValue = available ? value : '';
    this.renderTrigger();
    this.renderOptionState();
  }

  getValue(): string {
    return this.selectedValue;
  }

  setDisabled(disabled: boolean): void {
    this.disabledState = disabled;
    this.trigger.disabled = disabled;
    this.root.classList.toggle('is-disabled', disabled);
    if (disabled) this.close(false);
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.root.replaceChildren();
  }

  private allOptions(): ProtonRouteOption[] {
    return [...this.measuredRoutes];
  }

  private selectableOptions(): ProtonRouteOption[] {
    return this.loadingState ? [] : this.allOptions().filter((option) => !option.disabled);
  }

  private render(): void {
    this.renderMenu();
    this.renderTrigger();
  }

  private renderMenu(): void {
    this.menu.replaceChildren();
    this.highlightedIndex = -1;
    this.optionIdSequence = 0;
    if (this.loadingState) {
      this.measuredRoutes.forEach((option) => this.menu.appendChild(this.createOption(option)));
      const selectableRouteCount = this.measuredRoutes.filter((option) => !option.disabled).length;
      for (let index = selectableRouteCount; index < ROUTE_LOADING_PLACEHOLDERS; index += 1) {
        this.menu.appendChild(this.createLoadingOption());
      }
    } else {
      this.measuredRoutes.forEach((option) => this.menu.appendChild(this.createOption(option)));
    }
    this.renderOptionState();
  }


  private createLoadingOption(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'proton-route-select__loading';
    row.setAttribute('role', 'presentation');
    row.setAttribute('aria-hidden', 'true');

    const flag = document.createElement('span');
    flag.className = 'proton-route-select__loading-flag';
    const copy = document.createElement('span');
    copy.className = 'proton-route-select__loading-copy';
    const name = document.createElement('span');
    name.className = 'proton-route-select__loading-line proton-route-select__loading-line--name';
    const description = document.createElement('span');
    description.className = 'proton-route-select__loading-line proton-route-select__loading-line--description';
    copy.append(name, description);
    const ping = document.createElement('span');
    ping.className = 'proton-route-select__loading-ping';
    row.append(flag, copy, ping);
    return row;
  }

  private createOption(option: ProtonRouteOption): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `proton-route-select__option${option.recommended ? ' is-recommended' : ''}`;
    button.dataset.routeValue = option.value;
    button.id = `${this.menu.id}-option-${this.optionIdSequence++}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(option.value === this.selectedValue));
    button.disabled = Boolean(option.disabled || this.loadingState);

    const copy = document.createElement('span');
    copy.className = 'proton-route-select__option-copy';
    const name = document.createElement('span');
    name.className = 'proton-route-select__option-name';
    name.textContent = option.label;
    const description = document.createElement('span');
    description.className = 'proton-route-select__option-description';
    description.textContent = option.description;
    const descriptionRow = document.createElement('span');
    descriptionRow.className = 'proton-route-select__option-description-row';
    descriptionRow.appendChild(description);
    copy.append(name, descriptionRow);

    const top = document.createElement('span');
    top.className = 'proton-route-select__option-top';
    top.append(createFlag(option.countryCode), copy);

    let recommendedBadge: HTMLSpanElement | null = null;
    if (option.recommended) {
      recommendedBadge = document.createElement('span');
      recommendedBadge.className = 'proton-route-select__recommended';
      recommendedBadge.textContent = 'Recomendada';
    }

    const details = document.createElement('span');
    details.className = 'proton-route-select__option-details';
    details.appendChild(createPingBadge(option));
    details.appendChild(createSvgIcon('<path d="m5 12 4 4L19 6"/>', 'proton-route-select__check'));
    button.appendChild(top);
    if (recommendedBadge) button.appendChild(recommendedBadge);
    button.appendChild(details);
    return button;
  }

  private renderTrigger(): void {
    const option = this.allOptions().find((candidate) => candidate.value === this.selectedValue)
      ?? (this.loadingState ? LOADING_ROUTE_OPTION : EMPTY_ROUTE_OPTION);

    this.triggerFlag.replaceWith(createFlag(option.countryCode, this.triggerFlag.className));
    this.triggerFlag = this.root.querySelector('.proton-route-select__trigger-main > .proton-route-select__flag') as HTMLSpanElement;
    this.triggerLabel.textContent = option.label;
    this.triggerDescription.textContent = option.description;
    this.triggerPing.replaceWith(createPingBadge(option, true));
    this.triggerPing = this.root.querySelector('.proton-route-select__trigger-main > .proton-route-select__ping') as HTMLSpanElement;
    this.trigger.setAttribute('aria-label', `${option.label}: ${option.description}`);
  }

  private renderOptionState(): void {
    const allOptions = [...this.menu.querySelectorAll<HTMLButtonElement>('[data-route-value]')];
    allOptions.forEach((option) => {
      const selected = option.dataset.routeValue === this.selectedValue;
      option.setAttribute('aria-selected', String(selected));
      option.classList.toggle('is-selected', selected);
    });
    const selectableOptions = allOptions.filter((option) => !option.disabled);
    selectableOptions.forEach((option, index) => {
      option.classList.toggle('is-highlighted', index === this.highlightedIndex);
    });
    const highlighted = selectableOptions[this.highlightedIndex];
    if (this.openState && highlighted) {
      this.trigger.setAttribute('aria-activedescendant', highlighted.id);
    } else {
      this.trigger.removeAttribute('aria-activedescendant');
    }
  }

  private toggle(): void {
    if (this.disabledState) return;
    if (this.openState) this.close(true);
    else this.open();
  }

  private open(): void {
    if (this.disabledState) return;
    this.openState = true;
    this.root.classList.add('is-open');
    this.menu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    const options = this.selectableOptions();
    const selectedIndex = options.findIndex((option) => option.value === this.selectedValue);
    this.highlightedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.renderOptionState();
    this.openChangeHandler?.(true);
  }

  private close(restoreFocus: boolean): void {
    if (!this.openState) return;
    this.openState = false;
    this.root.classList.remove('is-open');
    this.menu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    this.highlightedIndex = -1;
    this.renderOptionState();
    this.openChangeHandler?.(false);
    if (restoreFocus) this.trigger.focus();
  }

  private moveHighlight(offset: number): void {
    const options = [...this.menu.querySelectorAll<HTMLButtonElement>('[data-route-value]:not(:disabled)')];
    if (options.length === 0) return;
    const nextIndex = (this.highlightedIndex + offset + options.length) % options.length;
    this.highlightedIndex = nextIndex;
    this.renderOptionState();
    options[nextIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private choose(value: string): void {
    const option = this.allOptions().find((candidate) => candidate.value === value);
    if (!option || option.disabled) return;
    const changed = option.value !== this.selectedValue;
    this.selectedValue = option.value;
    this.renderTrigger();
    this.renderOptionState();
    this.close(true);
    if (changed) this.changeHandler?.(option.value);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.disabledState) return;
    if (event.key === 'Tab') {
      this.close(false);
      return;
    }
    if (event.key === 'Escape') {
      if (this.openState) {
        event.preventDefault();
        this.close(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.openState) this.open();
      else this.moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!this.openState) return;
      event.preventDefault();
      const options = [...this.menu.querySelectorAll<HTMLButtonElement>('[data-route-value]:not(:disabled)')];
      this.highlightedIndex = event.key === 'Home' ? 0 : options.length - 1;
      this.renderOptionState();
      options[this.highlightedIndex]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!this.openState) {
        this.open();
        return;
      }
      const options = [...this.menu.querySelectorAll<HTMLButtonElement>('[data-route-value]:not(:disabled)')];
      const option = options[this.highlightedIndex];
      if (option) this.choose(option.dataset.routeValue || '');
    }
  }
}
