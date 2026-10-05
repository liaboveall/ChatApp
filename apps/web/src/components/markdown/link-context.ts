import { createContext } from 'react'

/**
 * Links inside a row that is not the current one of the timeline are taken out of the tab order, so Tab from the current
 * row goes to its own links and then on to the composer instead of through hundreds of links (docs/02 section 7).
 * A module of its own so the timeline can provide it without loading the renderer's chunk.
 */
export const LinkTabIndex = createContext<0 | -1 | undefined>(undefined)
