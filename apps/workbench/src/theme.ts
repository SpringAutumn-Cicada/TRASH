import {readPreference,writePreference} from './navigation.js';

export const themes=[{id:'graphite-purple',label:'石墨紫',browserColor:'#242633'},{id:'default',label:'经典绿',browserColor:'#f4f6f5'},{id:'blue',label:'蓝色科技',browserColor:'#f3f7fc'}] as const;
export type ThemeId=typeof themes[number]['id'];
export function resolveTheme(value:string|null|undefined):ThemeId{return themes.find(theme=>theme.id===value)?.id??'graphite-purple';}
export function savedTheme():ThemeId{return resolveTheme(readPreference('trash-theme'));}
export function applyTheme(value:ThemeId){
 const theme=themes.find(theme=>theme.id===value)!;
 document.documentElement.dataset.theme=value;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme.browserColor);
 writePreference('trash-theme',value);
}
