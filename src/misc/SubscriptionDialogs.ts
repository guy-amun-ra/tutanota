import type { LoginController } from "../api/main/LoginController"
import type { lazy } from "@tutao/tutanota-utils"
import { Dialog } from "../gui/base/Dialog"
import type { TranslationKey } from "./LanguageViewModel"
import { InfoLink, lang } from "./LanguageViewModel"
import { isIOSApp } from "../api/common/Env"
import type { clickHandler } from "../gui/base/GuiUtils"
import { locator } from "../api/main/MainLocator"
import { showSwitchDialog } from "../subscription/SwitchSubscriptionDialog.js"
import { BookingTypeRef } from "../api/entities/sys/TypeRefs.js"
import { assertNotNull, downcast, neverNull } from "@tutao/tutanota-utils"
import { GENERATED_MAX_ID } from "../api/common/utils/EntityUtils.js"
import { isNewPlan } from "../subscription/FeatureListProvider.js"
import { PlanTypeToName } from "../api/common/TutanotaConstants.js"

/**
 * Opens a dialog which states that the function is not available in the Free subscription and provides an option to upgrade.
 * @param isInPremiumIncluded Whether the feature is included in the premium membership or not.
 */
export async function showNotAvailableForFreeDialog(isInPremiumIncluded: boolean, customMessage?: TranslationKey) {
	const wizard = await import("../subscription/UpgradeSubscriptionWizard")

	if (isIOSApp()) {
		await Dialog.message("notAvailableInApp_msg")
	} else {
		const baseMessage =
			customMessage != null ? customMessage : !isInPremiumIncluded ? "onlyAvailableForPremiumNotIncluded_msg" : "onlyAvailableForPremium_msg"

		const message = `${lang.get(baseMessage)}\n\n${lang.get("premiumOffer_msg")}`
		const confirmed = await Dialog.reminder(lang.get("upgradeReminderTitle_msg"), message, InfoLink.PremiumProBusiness)
		if (confirmed) {
			wizard.showUpgradeWizard()
		}
	}
}

export function createNotAvailableForFreeClickHandler(includedInPremium: boolean, click: clickHandler, available: () => boolean): clickHandler {
	return (e, dom) => {
		if (!available()) {
			showNotAvailableForFreeDialog(includedInPremium)
		} else {
			click(e, dom)
		}
	}
}

/**
 * Returns whether premium is active and shows one of the showNotAvailableForFreeDialog or subscription cancelled dialogs if needed.
 */
export function checkPremiumSubscription(included: boolean): Promise<boolean> {
	if (locator.logins.getUserController().isFreeAccount()) {
		showNotAvailableForFreeDialog(included)
		return Promise.resolve(false)
	}

	return locator.logins
		.getUserController()
		.loadCustomer()
		.then((customer) => {
			if (customer.canceledPremiumAccount) {
				return Dialog.message("subscriptionCancelledMessage_msg").then(() => false)
			} else {
				return Promise.resolve(true)
			}
		})
}

export function showMoreStorageNeededOrderDialog(loginController: LoginController, messageIdOrMessageFunction: TranslationKey): Promise<void> {
	const userController = locator.logins.getUserController()

	if (!userController.isGlobalAdmin()) {
		return Dialog.message("insufficientStorageWarning_msg")
	}

	const confirmMsg = () => lang.get(messageIdOrMessageFunction) + "\n\n" + lang.get("onlyAvailableForPremiumNotIncluded_msg")

	return Dialog.confirm(confirmMsg, "upgrade_action").then((confirm) => {
		if (confirm) {
			import("../subscription/UpgradeSubscriptionWizard").then((wizard) => wizard.showUpgradeWizard())
		}
	})
}

/**
 * @returns true if the business feature has been ordered
 */
export async function showBusinessFeatureRequiredDialog(reason: TranslationKey | lazy<string>): Promise<boolean> {
	const userController = locator.logins.getUserController()
	if (userController.isFreeAccount()) {
		showNotAvailableForFreeDialog(false)
		return false
	} else {
		let customerInfo = await userController.loadCustomerInfo()
		const bookings = await locator.entityClient.loadRange(BookingTypeRef, neverNull(customerInfo.bookings).items, GENERATED_MAX_ID, 1, true)
		await showSwitchDialog(await userController.loadCustomer(), customerInfo, await userController.loadAccountingInfo(), assertNotNull(bookings[0]))
		customerInfo = await userController.loadCustomerInfo()
		// FIXME wait until SwitchAccountTypeService was invoked and customerInfo was updated.
		return isNewPlan(downcast(customerInfo.plan))
	}
}
