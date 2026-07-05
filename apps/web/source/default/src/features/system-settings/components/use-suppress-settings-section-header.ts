import { useContext } from 'react'
import { SettingsPageContext } from './settings-page-context-value'

export function useSuppressSettingsSectionHeader() {
  return useContext(SettingsPageContext).suppressSectionHeader
}
