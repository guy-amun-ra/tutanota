import o from "ospec"
import { DarkPreferenceTracker, ThemeController } from "../../../src/gui/ThemeController.js"
import type { ThemeCustomizations } from "../../../src/misc/WhitelabelCustomizations.js"
import { downcast } from "@tutao/tutanota-utils"
import { ThemeFacade } from "../../../src/native/common/generatedipc/ThemeFacade"
import { HtmlSanitizer } from "../../../src/misc/HtmlSanitizer.js"
import { matchers, object, when } from "testdouble"
import { verify } from "@tutao/tutanota-test-utils"

o.spec("Theme Controller", function () {
	let themeManager: ThemeController
	let themeFacadeMock: ThemeFacade
	let htmlSanitizerMock: HtmlSanitizer
	let darkPrefMock: DarkPreferenceTracker

	o.beforeEach(async function () {
		themeFacadeMock = object()
		when(themeFacadeMock.getThemes()).thenResolve([])

		htmlSanitizerMock = object()
		// this is called in the constructor. Eh!
		when(htmlSanitizerMock.sanitizeHTML(matchers.anything())).thenReturn({
			html: "sanitized",
			externalContent: [],
			inlineImageCids: [],
			links: [],
		})
		darkPrefMock = object()
		themeManager = new ThemeController(themeFacadeMock, () => Promise.resolve(htmlSanitizerMock), darkPrefMock)
		await themeManager.initialized
	})

	o("updateCustomTheme", async function () {
		const theme: ThemeCustomizations = downcast({
			themeId: "HelloFancyId",
			content_bg: "#fffeee",
			logo: "unsanitized_logo",
			base: "light",
		})

		await themeManager.updateCustomTheme(theme)

		const captor = matchers.captor()
		verify(themeFacadeMock.setThemes(captor.capture()))
		const savedTheme = captor.values![0][3]
		o(savedTheme.themeId).equals("HelloFancyId")
		o(savedTheme.content_bg).equals("#fffeee")
		o(savedTheme.logo).equals("sanitized")
		o(savedTheme.content_fg).equals(themeManager.getDefaultTheme().content_fg)
		o(themeManager._theme.logo).equals("sanitized")
	})

	o("when using automatic theme and preferring dark, dark theme is applied, and themeId is automatic", async function () {
		when(themeFacadeMock.getSelectedTheme()).thenResolve("automatic")
		when(darkPrefMock.prefersDarkColorScheme()).thenReturn(true)

		await themeManager.reloadTheme()

		o(themeManager.getCurrentTheme().themeId).equals("dark")
		o(themeManager.themeId).equals("automatic")
	})

	o("when using automatic theme and preferring light, light theme is applied, and themeId is automatic", async function () {
		when(themeFacadeMock.getSelectedTheme()).thenResolve("automatic")
		when(darkPrefMock.prefersDarkColorScheme()).thenReturn(false)

		await themeManager.reloadTheme()

		o(themeManager.getCurrentTheme().themeId).equals("light")
		o(themeManager.themeId).equals("automatic")
	})

	o("when switching to automatic and preferring the light theme, light theme is applied, and themeId is automatic", async function () {
		when(themeFacadeMock.getSelectedTheme()).thenResolve("dark")
		await themeManager._initializeTheme()

		when(darkPrefMock.prefersDarkColorScheme()).thenReturn(false)
		await themeManager.setThemeId("automatic")

		o(themeManager.getCurrentTheme().themeId).equals("light")
		o(themeManager.themeId).equals("automatic")
	})
})
