/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSelector } from '@reduxjs/toolkit';
import * as _ from 'lodash';
import { selectMapState } from '../../reducers/maps';
import { DataType } from '../../types/Datasources';
import { GroupedOption, SelectOption } from '../../types/items';
import { ChartTypes, MeterOrGroup } from '../../types/redux/graph';
import { UnitDataById, UnitRepresentType } from '../../types/redux/units';
import {
	CartesianPoint, Dimensions, calculateScaleFromEndpoints, gpsToUserGrid,
	itemDisplayableOnMap, itemMapInfoOk, normalizeImageDimensions
} from '../../utils/calibration';
import { metersInGroup, unitsCompatibleWithMeters } from '../../utils/determineCompatibleUnits';
import { AreaUnitType } from '../../utils/getAreaUnitConversion';
import {
	selectChartToRender, selectGraphAreaNormalization,
	selectSelectedGroups, selectSelectedMeters,
	selectSelectedUnit
} from '../../reducers/graph';
import { selectGroupDataById } from '../../redux/api/groupsApi';
import { selectUnitDataById } from '../../redux/api/unitsApi';
import { selectVisibleMetersAndGroups, selectVisibleUnitOrSuffixState } from './authVisibilitySelectors';
import { MeterDataByID } from 'types/redux/meters';
import { GroupDataByID } from 'types/redux/groups';
import { selectMeterDataById } from '../../redux/api/metersApi';



export const selectCurrentUnitCompatibility = createSelector(
	selectVisibleMetersAndGroups,
	selectMeterDataById,
	selectGroupDataById,
	selectSelectedUnit,
	(visible, meterDataById, groupDataById, selectedUnitId) => {
		// meters and groups that can graph
		const compatibleMeters = new Set<number>();
		const compatibleGroups = new Set<number>();

		// meters and groups that cannot graph.
		const incompatibleMeters = new Set<number>();
		const incompatibleGroups = new Set<number>();

		visible.meters.forEach(meterId => {
			const meterGraphingUnit = meterDataById[meterId].defaultGraphicUnit;
			// when no unit is currently selected, every meter/group is valid provided it has a default graphic unit
			// If the meter/group has a default graphic unit set then it can graph, otherwise it cannot.
			// selectedUnitId -99 indicates no unit selected
			if (selectedUnitId === -99 && meterGraphingUnit === -99) {
				// No Unit Selected and Default graphic unit is not set
				incompatibleMeters.add(meterId);
			}
			else if (selectedUnitId === -99) {
				// no unitSelected, but has a default unit
				compatibleMeters.add(meterId)
			}
			else {
				// A unit is selected
				// Get all of compatible units for this meter
				const compatibleUnits = unitsCompatibleWithMeters(new Set<number>([meterId]));
				// Then, check if the selected unit exists in that set of compatible units
				compatibleUnits.has(selectedUnitId) ? compatibleMeters.add(meterId) : incompatibleMeters.add(meterId);
			}
		});

		// Same As Meters
		visible.groups
			.forEach(groupId => {
				const groupGraphingUnit = groupDataById[groupId].defaultGraphicUnit;
				if (selectedUnitId === -99 && groupGraphingUnit === -99) {
					incompatibleGroups.add(groupId);
				}
				else if (selectedUnitId === -99) {
					compatibleGroups.add(groupId)
				}
				else {
					// Get the set of units compatible with the current group (through its deepMeters attribute)
					// TODO If a meter in a group is not visible to this user then it is not in Redux state and this fails.
					const compatibleUnits = unitsCompatibleWithMeters(metersInGroup(groupId));
					compatibleUnits.has(selectedUnitId) ? compatibleGroups.add(groupId) : incompatibleGroups.add(groupId);
				}
			})

		return { compatibleMeters, incompatibleMeters, compatibleGroups, incompatibleGroups }
	}
)

export const selectCurrentAreaCompatibility = createSelector(
	selectCurrentUnitCompatibility,
	selectGraphAreaNormalization,
	selectSelectedUnit,
	selectMeterDataById,
	selectGroupDataById,
	selectUnitDataById,
	(currentUnitCompatibility, areaNormalization, selectedUnit, meterDataById, groupDataById, unitDataById) => {
		// Deep Copy previous selector's values, and update as needed based on current Area Normalization setting
		const compatibleMeters = new Set<number>(currentUnitCompatibility.compatibleMeters);
		const compatibleGroups = new Set<number>(currentUnitCompatibility.compatibleGroups);

		// meters and groups that cannot graph.
		const incompatibleMeters = new Set<number>(currentUnitCompatibility.incompatibleMeters);
		const incompatibleGroups = new Set<number>(currentUnitCompatibility.incompatibleGroups);

		// only run this check if area normalization is on
		if (areaNormalization) {
			compatibleMeters.forEach(meterID => {
				// No unit is selected then no meter/group should be selected if area normalization is enabled and meter type is raw
				if (!isAreaNormCompatible(meterID, selectedUnit, meterDataById, unitDataById)) {
					incompatibleMeters.add(meterID);
				}
			});
			compatibleGroups.forEach(groupID => {
				if (!isAreaNormCompatible(groupID, selectedUnit, groupDataById, unitDataById)) {
					incompatibleGroups.add(groupID);
				}
			});
		}
		// Filter out any new incompatible meters/groups from the compatibility list.
		incompatibleMeters.forEach(meterID => compatibleMeters.delete(meterID))
		incompatibleGroups.forEach(groupID => compatibleGroups.delete(groupID))
		return { compatibleMeters, incompatibleMeters, compatibleGroups, incompatibleGroups }
	}
)

export const selectChartTypeCompatibility = createSelector(
	selectCurrentAreaCompatibility,
	selectChartToRender,
	selectMeterDataById,
	selectGroupDataById,
	selectMapState,
	(areaCompat, chartToRender, meterDataById, groupDataById, mapState) => {
		// Deep Copy previous selector's values, and update as needed based on current ChartType(s)
		const compatibleMeters = new Set<number>(Array.from(areaCompat.compatibleMeters));
		const incompatibleMeters = new Set<number>(Array.from(areaCompat.incompatibleMeters));

		const compatibleGroups = new Set<number>(Array.from(areaCompat.compatibleGroups));
		const incompatibleGroups = new Set<number>(Array.from(areaCompat.incompatibleGroups));



		// ony run this check if we are displaying a map chart
		if (chartToRender === ChartTypes.map && mapState.selectedMap !== 0) {
			const mp = mapState.byMapID[mapState.selectedMap];
			// filter meters;
			const image = mp.image;
			// The size of the original map loaded into OED.
			const imageDimensions: Dimensions = {
				width: image.width,
				height: image.height
			};
			// Determine the dimensions so within the Plotly coordinates on the user map.
			const imageDimensionNormalized = normalizeImageDimensions(imageDimensions);
			// The following is needed to get the map scale. Now that the system accepts maps that are not
			// pointed north, it would be better to store the origin GPS and the scale factor instead of
			// the origin and opposite GPS. For now, not going to change but could if redo DB and interface
			// for maps.
			// Convert the gps value to the equivalent Plotly grid coordinates on user map.
			// First, convert from GPS to grid units. Since we are doing a GPS calculation, this happens on the true north map.
			// It must be on true north map since only there are the GPS axes parallel to the map axes.
			// To start, calculate the user grid coordinates (Plotly) from the GPS value. This involves calculating
			// it coordinates on the true north map and then rotating/shifting to the user map.
			// This is the origin & opposite from the calibration. It is the lower, left
			// and upper, right corners of the user map.
			// The gps value can be null from the database. Note using gps !== null to check for both null and undefined
			// causes TS to complain about the unknown case so not used.
			const origin = mp.origin;
			const opposite = mp.opposite;
			compatibleMeters.forEach(meterID => {
				// This meter's GPS value.
				const gps = meterDataById[meterID].gps;
				if (origin !== undefined && opposite !== undefined && gps !== undefined && gps !== null) {
					// Get the GPS degrees per unit of Plotly grid for x and y. By knowing the two corners
					// (or really any two distinct points) you can calculate this by the change in GPS over the
					// change in x or y which is the map's width & height in this case.
					const scaleOfMap = calculateScaleFromEndpoints(origin, opposite, imageDimensionNormalized, mp.northAngle);
					// Convert GPS of meter to grid on user map. See calibration.ts for more info on this.
					const meterGPSInUserGrid: CartesianPoint = gpsToUserGrid(imageDimensionNormalized, gps, origin, scaleOfMap, mp.northAngle);
					if (!(itemMapInfoOk(meterID, DataType.Meter, mp, gps) &&
						itemDisplayableOnMap(imageDimensionNormalized, meterGPSInUserGrid))) {
						incompatibleMeters.add(meterID);
					}
				} else {
					// Lack info on this map so skip. This is mostly done since TS complains about the undefined possibility.
					incompatibleMeters.add(meterID);
				}
			});

			// The below code follows the logic for meters shown above. See comments above for clarification on the below code.
			compatibleGroups.forEach(groupID => {
				const gps = groupDataById[groupID].gps;
				if (origin !== undefined && opposite !== undefined && gps !== undefined && gps !== null) {
					const scaleOfMap = calculateScaleFromEndpoints(origin, opposite, imageDimensionNormalized, mp.northAngle);
					const groupGPSInUserGrid: CartesianPoint = gpsToUserGrid(imageDimensionNormalized, gps, origin, scaleOfMap, mp.northAngle);
					if (!(itemMapInfoOk(groupID, DataType.Group, mp, gps) &&
						itemDisplayableOnMap(imageDimensionNormalized, groupGPSInUserGrid))) {
						incompatibleGroups.add(groupID);
					}
				} else {
					incompatibleGroups.add(groupID);
				}
			});
		}

		return {
			compatibleMeters,
			compatibleGroups,
			incompatibleMeters,
			incompatibleGroups
		}
	}
)

export const selectMeterGroupSelectData = createSelector(
	selectChartTypeCompatibility,
	selectMeterDataById,
	selectGroupDataById,
	selectSelectedMeters,
	selectSelectedGroups,
	(chartTypeCompatibility, meterDataById, groupDataById, selectedMeters, selectedGroups) => {
		// Destructure Previous Selectors's values
		const { compatibleMeters, incompatibleMeters, compatibleGroups, incompatibleGroups } = chartTypeCompatibility;

		// Calculate final compatible meters and groups for dropdown
		const compatibleSelectedMeters = new Set<number>();
		const incompatibleSelectedMeters = new Set<number>();
		selectedMeters.forEach(meterID => {
			// Sort and populate compatible/incompatible based on previous selector's compatible meters
			compatibleMeters.has(meterID) ? compatibleSelectedMeters.add(meterID) : incompatibleSelectedMeters.add(meterID)
		});


		const compatibleSelectedGroups = new Set<number>();
		const incompatibleSelectedGroups = new Set<number>();
		selectedGroups.forEach(groupID => {
			// Sort and populate compatible/incompatible based on previous selector's compatible groups
			compatibleGroups.has(groupID) ? compatibleSelectedGroups.add(groupID) : incompatibleSelectedGroups.add(groupID)
		});

		// The Multiselect's current selected value(s)
		const selectedMeterOptions = getSelectOptionsByItem(compatibleSelectedMeters, incompatibleSelectedMeters, meterDataById, 'meter')
		const selectedGroupOptions = getSelectOptionsByItem(compatibleSelectedGroups, incompatibleSelectedGroups, groupDataById, 'group')

		// List of options with metadata for react-select
		const meterSelectOptions = getSelectOptionsByItem(compatibleMeters, incompatibleMeters, meterDataById, 'meter')
		const groupSelectOptions = getSelectOptionsByItem(compatibleGroups, incompatibleGroups, groupDataById, 'group')

		// currently when selected values are found to be incompatible get removed from selected options  (by area for example) .
		// in the near future they should instead remain 'selected' but visually appear disabled.
		// TODO write custom React-Select component to be able to utilize these values
		// The select options have an attached 'disabled' boolean which can be used when writing custom component for react-select
		// These value(s) is not currently utilized
		const allSelectedMeterValues = selectedMeterOptions.compatible.concat(selectedMeterOptions.incompatible)
		const allSelectedGroupValues = selectedGroupOptions.compatible.concat(selectedGroupOptions.incompatible)

		// Format The generated selectOptions into grouped options for the React-Select component
		const meterGroupedOptions: GroupedOption[] = [
			{ label: 'Meters', options: meterSelectOptions.compatible },
			{ label: 'Incompatible Meters', options: meterSelectOptions.incompatible }
		]
		const groupsGroupedOptions: GroupedOption[] = [
			{ label: 'Options', options: groupSelectOptions.compatible },
			{ label: 'Incompatible Options', options: groupSelectOptions.incompatible }
		]

		return { meterGroupedOptions, groupsGroupedOptions, selectedMeterOptions, selectedGroupOptions, allSelectedMeterValues, allSelectedGroupValues }
	}
)



export const selectUnitSelectData = createSelector(
	selectUnitDataById,
	selectVisibleUnitOrSuffixState,
	selectSelectedMeters,
	selectSelectedGroups,
	selectGraphAreaNormalization,
	(unitDataById, visibleUnitsOrSuffixes, selectedMeters, selectedGroups, areaNormalization) => {
		// Holds all units that are compatible with selected meters/groups
		const compatibleUnits = new Set<number>();
		// Holds all units that are not compatible with selected meters/groups
		const incompatibleUnits = new Set<number>();

		// Holds all selected meters, including those retrieved from groups
		const allSelectedMeters = new Set<number>();

		// Get for all meters
		selectedMeters.forEach(meter => {
			allSelectedMeters.add(meter);
		});
		// Get for all groups
		selectedGroups.forEach(group => {
			// Get for all deep meters in group
			metersInGroup(group).forEach(meter => {
				allSelectedMeters.add(meter);
			});
		});

		if (allSelectedMeters.size == 0) {
			// No meters/groups are selected. This includes the case where the selectedUnit is -99.
			// Every unit is okay/compatible in this case so skip the work needed below.
			// Filter the units to be displayed by user status and displayable type
			visibleUnitsOrSuffixes.forEach(unit => {
				if (areaNormalization && unit.unitRepresent === UnitRepresentType.raw) {
					incompatibleUnits.add(unit.id);
				} else {
					compatibleUnits.add(unit.id);
				}
			});
		} else {
			// Some meter or group is selected
			// Retrieve set of units compatible with list of selected meters and/or groups
			const units = unitsCompatibleWithMeters(allSelectedMeters);

			// Loop over all units (they must be of type unit or suffix - case 1)
			visibleUnitsOrSuffixes.forEach(o => {
				// Control displayable ones (case 2)
				if (units.has(o.id)) {
					// Should show as compatible (case 3)
					compatibleUnits.add(o.id);
				} else {
					// Should show as incompatible (case 4)
					incompatibleUnits.add(o.id);
				}
			});
		}
		// Ready to display unit. Put selectable ones before non-selectable ones.
		const unitOptions = getSelectOptionsByItem(compatibleUnits, incompatibleUnits, unitDataById, 'unit');
		const unitsGroupedOptions: GroupedOption[] = [
			{
				label: 'Units',
				options: unitOptions.compatible
			},
			{
				label: 'Incompatible Units',
				options: unitOptions.incompatible
			}
		]
		return unitsGroupedOptions
	}
)

/**
 *  Returns a set of SelectOptions based on the type of state passed in and sets the visibility.
 * Visibility is determined by which set the items are contained in.
 * @param compatibleItems - compatible items to make select options for
 * @param incompatibleItems - incompatible items to make select options for
 * @param dataById - current redux state, must be one of UnitsState, MetersState, or GroupsState
 * @param type - one of the current variables
 * @returns Two Lists: Compatible, and Incompatible selectOptions for use as grouped React-Select options
 */
export function getSelectOptionsByItem(
	compatibleItems: Set<number>,
	incompatibleItems: Set<number>,
	// using any due to ts errs
	dataById: any,
	// After moving to RTK the older instanceOfx no longer works due to lack of meter,group,unit state reducers.
	type: 'meter' | 'group' | 'unit') {
	// TODO Refactor original
	// redefined here for testing.
	// Holds the label of the select item, set dynamically according to the type of item passed in


	//The final list of select options to be displayed
	const compatibleItemOptions: SelectOption[] = [];
	const incompatibleItemOptions: SelectOption[] = [];

	//Loop over each itemId and create an activated select option
	compatibleItems.forEach(itemId => {
		let label = '';
		let meterOrGroup: MeterOrGroup | undefined;
		let defaultGraphicUnit: number | undefined;
		// Perhaps in the future this can be done differently
		// Loop over the state type to see what state was passed in (units, meter, group, etc)
		// Set the label correctly based on the type of state
		// If this is converted to a switch statement the instanceOf function needs to be called twice
		// Once for the initial state type check, again because the interpreter (for some reason) needs to be sure that the property exists in the object
		// If else statements do not suffer from this
		if (type === 'unit') {
			label = dataById[itemId]?.identifier;
		}
		else if (type === 'meter') {
			label = dataById[itemId]?.identifier;
			meterOrGroup = MeterOrGroup.meters
			defaultGraphicUnit = dataById[itemId]?.defaultGraphicUnit;
		}
		else if (type === 'group') {
			label = dataById[itemId]?.name;
			meterOrGroup = MeterOrGroup.groups
			defaultGraphicUnit = dataById[itemId]?.defaultGraphicUnit;
		}
		// TODO This is a bit of a hack. When an admin logs in they may not have the new state so label is null.
		// This should clear once the state is loaded.
		// label = label === null ? '' : label;
		compatibleItemOptions.push({
			value: itemId,
			label: label,
			// If option is compatible then not disabled
			isDisabled: false,
			meterOrGroup: meterOrGroup,
			defaultGraphicUnit: defaultGraphicUnit
		} as SelectOption
		);
	});

	incompatibleItems.forEach(itemId => {
		let label = '';
		let meterOrGroup: MeterOrGroup | undefined;
		let defaultGraphicUnit: number | undefined;
		if (type === 'unit') {
			label = dataById[itemId].identifier;
		}
		else if (type === 'meter') {
			label = dataById[itemId]?.identifier;
			meterOrGroup = MeterOrGroup.meters
			defaultGraphicUnit = dataById[itemId]?.defaultGraphicUnit;
		}
		else if (type === 'group') {
			label = dataById[itemId]?.name;
			meterOrGroup = MeterOrGroup.groups
			defaultGraphicUnit = dataById[itemId]?.defaultGraphicUnit;
		}
		incompatibleItemOptions.push({
			value: itemId,
			label: label,
			// If option is compatible then not disabled
			isDisabled: true,
			meterOrGroup: meterOrGroup,
			defaultGraphicUnit: defaultGraphicUnit
		} as SelectOption
		);
	});
	const compatible = _.sortBy(compatibleItemOptions, item => item.label?.toLowerCase(), 'asc')
	const incompatible = _.sortBy(incompatibleItemOptions, item => item.label?.toLowerCase(), 'asc')


	return { compatible, incompatible }
}



// Helper function for area compatibility
// areaNorm should be active when called
const isAreaNormCompatible = (id: number, selectedUnit: number, meterOrGroupData: MeterDataByID | GroupDataByID, unitDataById: UnitDataById) => {
	const meterGraphingUnit = meterOrGroupData[id].defaultGraphicUnit;

	// If no unit is selected then no meter/group should be selected if meter type is raw
	const noUnitAndRaw = selectedUnit === -99 && unitDataById[meterGraphingUnit]?.unitRepresent === UnitRepresentType.raw

	// do not allow meter to be selected if it has zero area or no area unit
	const noAreaOrUnitType = meterOrGroupData[id].area === 0 || meterOrGroupData[id].areaUnit === AreaUnitType.none
	const isAreaNormCompatible = !noUnitAndRaw && !noAreaOrUnitType
	return isAreaNormCompatible
}