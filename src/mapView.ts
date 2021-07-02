import { App, ButtonComponent, MarkdownView, getAllTags, ItemView, MenuItem, Menu, TFile, TextComponent, DropdownComponent, WorkspaceLeaf } from 'obsidian';
import * as leaflet from 'leaflet';
import 'leaflet-extra-markers';
import 'leaflet-extra-markers/dist/css/leaflet.extra-markers.min.css';
import '@fortawesome/fontawesome-free/js/all.min';
import 'leaflet/dist/leaflet.css';
import { GeoSearchControl, OpenStreetMapProvider } from 'leaflet-geosearch';
import 'leaflet-geosearch/dist/geosearch.css';

import * as consts from 'src/consts';
import { PluginSettings, DEFAULT_SETTINGS } from 'src/settings';
import { MarkersMap, FileMarker, buildMarkers } from 'src/markers';
import MapViewPlugin  from 'src/main';

type MapState = {
	mapZoom: number;
	mapCenter: leaflet.LatLng;
	tags: string[];
	version: number;
} 

export class MapView extends ItemView {
	private settings: PluginSettings;
	// The private state needs to be updated solely via updateMapToState
	private state: MapState;
	private display = new class {
		map: leaflet.Map;
		markers: MarkersMap = new Map();
		mapDiv: HTMLDivElement;
		tagsBox: TextComponent;
	};
	private plugin: MapViewPlugin;
	private defaultState: MapState;

	public onAfterOpen: (map: leaflet.Map, markers: MarkersMap) => any = null;

	constructor(leaf: WorkspaceLeaf, settings: PluginSettings, plugin: MapViewPlugin) {
		super(leaf);
		this.navigation = true;
		this.settings = settings;
		this.plugin = plugin;
		// Create the default state by the configuration
		this.defaultState = {
			mapZoom: this.settings.defaultZoom || consts.DEFAULT_ZOOM,
			mapCenter: this.settings.defaultMapCenter || consts.DEFAULT_CENTER,
			tags: this.settings.defaultTags || consts.DEFAULT_TAGS,
			version: 0
		};
		this.state = this.defaultState;
		this.setState = async (state: MapState, result) => {
			if (state) {
				console.log(`Received setState:`, state);
				// We give the given state priority by setting a high version
				state.version = 100;
				await this.updateMapToState(state);
			}
		}
		this.getState = (): MapState => {
			return this.state;
		}
	}

	public zoomToLocation(location: leaflet.LatLng) {
		let newState: MapState = {
			mapCenter: location,
			mapZoom: this.settings.zoomOnGoFromNote,
			tags: this.state.tags,
			version: this.state.version + 1
		};
		this.updateMapToState(newState);
	}

	getViewType() { return 'map'; }
	getDisplayText() { return 'Interactive Map View'; }

	onOpen() {
		var that = this;
		let controlsDiv = createDiv({
			'cls': 'graph-controls',
			'text': 'Filters'
		}, (el: HTMLDivElement) => {
			el.style.position = 'fixed';
			el.style.zIndex = '2';
		});
		this.display.tagsBox = new TextComponent(controlsDiv);
		this.display.tagsBox.setPlaceholder('Tags, e.g. "#one,#two"');
		this.display.tagsBox.onChange(async (tagsBox: string) => {
			that.state.tags = tagsBox.split(',').filter(t => t.length > 0);
			await this.updateMapToState(this.state, this.settings.autoZoom);
		});
		let tagSuggestions = new DropdownComponent(controlsDiv);
		tagSuggestions.setValue('Quick add tag');
		tagSuggestions.addOption('', 'Quick add tag');
		for (const tagName of this.getAllTagNames())
			tagSuggestions.addOption(tagName, tagName);
		tagSuggestions.onChange(value => {
			let currentTags = this.display.tagsBox.getValue();
			if (currentTags.indexOf(value) < 0) {
				this.display.tagsBox.setValue(currentTags.split(',').filter(tag => tag.length > 0).concat([value]).join(','));
			}
			tagSuggestions.setValue('Quick add tag');
			this.display.tagsBox.inputEl.focus();
			this.display.tagsBox.onChanged();
		});
		let goDefault = new ButtonComponent(controlsDiv);
		goDefault
			.setButtonText('Reset')
			.setTooltip('Reset the view to the defined default.')
			.onClick(async () => {
				let newState = {
					mapZoom: this.settings.defaultZoom || consts.DEFAULT_ZOOM,
					mapCenter: this.settings.defaultMapCenter || consts.DEFAULT_CENTER,
					tags: this.settings.defaultTags || consts.DEFAULT_TAGS,
					version: this.state.version + 1
				};
				await this.updateMapToState(newState);
			});
		let fitButton = new ButtonComponent(controlsDiv);
		fitButton
			.setButtonText('Fit')
			.setTooltip('Set the map view to fit all currently-displayed markers.')
			.onClick(() => this.autoFitMapToMarkers());
		let setDefault = new ButtonComponent(controlsDiv);
		setDefault
			.setButtonText('Set as Default')
			.setTooltip('Set this view (map state & filters) as default.')
			.onClick(async () => {
				this.settings.defaultZoom = this.state.mapZoom;
				this.settings.defaultMapCenter = this.state.mapCenter;
				this.settings.defaultTags = this.state.tags;
				await this.plugin.saveSettings();
			});
		this.contentEl.style.padding = '0px 0px';
		this.contentEl.append(controlsDiv);
		this.display.mapDiv = createDiv({cls: 'map'}, (el: HTMLDivElement) => {
			el.style.zIndex = '1';
			el.style.width = '100%';
			el.style.height = '100%';
		});
		this.contentEl.append(this.display.mapDiv);

		this.createMap();

		return super.onOpen();
	}

	onResize() {
		this.display.map.invalidateSize();
	}

	async createMap() {
		var that = this;
		this.display.map = new leaflet.Map(this.display.mapDiv, {
			center: new leaflet.LatLng(40.731253, -73.996139),
			zoom: 13,
			zoomControl: false});
		leaflet.control.zoom({
			position: 'topright'
		}).addTo(this.display.map);
		const attribution = this.settings.tilesUrl === DEFAULT_SETTINGS.tilesUrl ?
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' : '';
		this.display.map.addLayer(new leaflet.TileLayer(this.settings.tilesUrl, {
			maxZoom: 20,
			subdomains:['mt0','mt1','mt2','mt3'],
			attribution: attribution,
			className: this.settings.darkMode ? "dark-mode" : ""
		}));
		const searchControl = GeoSearchControl({
			provider: new OpenStreetMapProvider(),
			position: 'topright',
			marker: {
				icon: consts.SEARCH_RESULT_MARKER
			},
			style: 'button'});
		this.display.map.addControl(searchControl);
		this.display.map.on('zoomend', (event: leaflet.LeafletEvent) => {
			this.state.mapZoom = this.display.map.getZoom();
		});
		this.display.map.on('moveend', (event: leaflet.LeafletEvent) => {
			this.state.mapCenter = this.display.map.getCenter();
		});
		this.display.map.on('contextmenu', async (event: leaflet.LeafletMouseEvent) => {
			let mapPopup = new Menu(this.app);
			mapPopup.setNoIcon();
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as coordinates`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(location);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as front matter`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(`---\nlocation: [${location}]\n---\n\n`);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as inline`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(`\`location: [${location}]\``);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				item.setTitle('Open in Google Maps');
				item.onClick(_ev => {
					open(`https://maps.google.com/?q=${event.latlng.lat},${event.latlng.lng}`);
				});
			});
			mapPopup.showAtPosition(event.originalEvent);
		});
		this.display.map.whenReady(async () => {
			await that.updateMapToState(this.defaultState, !this.settings.defaultZoom);
			if (this.onAfterOpen != null)
				this.onAfterOpen(this.display.map, this.display.markers);
		})

	}

	// Updates the map to the given state and then sets the state accordingly, but only if the given state version
	// is not lower than the current state version (so concurrent async updates always keep the latest one)
	async updateMapToState(state: MapState, autoFit: boolean = false) {
		const files = this.getFileListByQuery(state.tags);
		let newMarkers = await buildMarkers(files, this.settings, this.app);
		if (state.version < this.state.version) {
			// If the state we were asked to update is old (e.g. because while we were building markers a newer instance
			// of the method was called), cancel the update
			return;
		}
		this.state = state;
		this.updateMapMarkers(newMarkers);
		this.display.tagsBox.setValue(this.state.tags.filter(tag => tag.length > 0).join(','));
		this.display.map.setView(this.state.mapCenter, this.state.mapZoom);
		if (autoFit)
			this.autoFitMapToMarkers();
	}

	getFileListByQuery(tags: string[]): TFile[] {
		let results: TFile[] = [];
		const allFiles = this.app.vault.getFiles();
		for (const file of allFiles) {
			var match = true;
			if (tags.length > 0) {
				// A tags query exist, file defaults to non-matching and we'll add it if it has one of the tags
				match = false;
				const fileCache = this.app.metadataCache.getFileCache(file);
				if (fileCache && fileCache.tags) {
					const tagsMatch = fileCache.tags.some(tagInFile => tags.indexOf(tagInFile.tag) > -1);
					if (tagsMatch)
						match = true;
				}
			}
			if (match)
				results.push(file);
		}
		return results;
	}

	updateMapMarkers(newMarkers: FileMarker[]) {
		let newMarkersMap: MarkersMap = new Map();
		for (let marker of newMarkers) {
			if (this.display.markers.has(marker.id)) {
				// This marker exists, so just keep it
				// TODO: check if its string or marker has changed
				newMarkersMap.set(marker.id, this.display.markers.get(marker.id));
				this.display.markers.delete(marker.id);
			} else {
				// New marker - create it
				marker.mapMarker = leaflet.marker(marker.location, { icon: marker.icon || new leaflet.Icon.Default() })
					.addTo(this.display.map)
					.bindTooltip(marker.file.name);
				marker.mapMarker.on('click', (event: leaflet.LeafletEvent) => {
					this.goToMarker(marker);
				});
				marker.mapMarker.getElement().addEventListener('contextmenu', (ev: MouseEvent) => {
					let mapPopup = new Menu(this.app);
					mapPopup.setNoIcon();
					mapPopup.addItem((item: MenuItem) => {
						item.setTitle('Open note');
						item.onClick(async ev => { this.goToMarker(marker); });
					});
					mapPopup.addItem((item: MenuItem) => {
						item.setTitle('Open in Google Maps');
						item.onClick(ev => {
							open(`https://maps.google.com/?q=${marker.location.lat},${marker.location.lng}`);
						});
					});
					mapPopup.showAtPosition(ev);
					ev.stopPropagation();
				})
				newMarkersMap.set(marker.id, marker);
			}
		}
		for (let [key, value] of this.display.markers) {
			value.mapMarker.removeFrom(this.display.map);
		}
		this.display.markers = newMarkersMap;
	}

	async autoFitMapToMarkers() {
		if (this.display.markers.size > 0) {
			const locations: leaflet.LatLng[] = Array.from(this.display.markers.values()).map(fileMarker => fileMarker.location);
			console.log(`Auto fit by state:`, this.state);
			this.display.map.fitBounds(leaflet.latLngBounds(locations));
		}
	}

	async goToMarker(marker: FileMarker) {
		await this.app.workspace.activeLeaf.openFile(marker.file);
		const editor = this.getEditor();
		if (editor) {
			if (marker.fileLocation)
				editor.setCursor(editor.posFromIndex(marker.fileLocation));
			editor.focus();
		}
	}

	getAllTagNames() : string[] {
		let tags: string[] = [];
		const allFiles = this.app.vault.getFiles();
		for (const file of allFiles) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache && fileCache.tags) {
				const fileTagNames = getAllTags(fileCache);
				tags = tags.concat(fileTagNames.filter(tagName => tags.indexOf(tagName) < 0));
			}
		}
		tags = tags.sort();
		return tags;
	}

	getEditor() {
		var view = this.app.workspace.activeLeaf.view;
		if (view.getViewType() == 'markdown') {
			var markdownView = view as MarkdownView;
			var cmEditor = markdownView.sourceMode.cmEditor;
			return cmEditor;
		}
		return null;
	}
}
