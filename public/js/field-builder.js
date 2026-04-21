(function () {
  function initFieldBuilder() {
    var rowsContainer = document.getElementById('fieldRows');
    var addButton = document.getElementById('addFieldRowBtn');
    var rowTemplate = document.getElementById('fieldRowTemplate');

    if (!rowsContainer || !addButton || !rowTemplate) {
      return;
    }

    function refreshRemoveButtons() {
      var removeButtons = rowsContainer.querySelectorAll('.js-remove-field');
      var disableRemove = rowsContainer.children.length <= 1;

      removeButtons.forEach(function (button) {
        button.disabled = disableRemove;
      });
    }

    function bindRow(rowElement) {
      var removeButton = rowElement.querySelector('.js-remove-field');
      if (!removeButton) {
        return;
      }

      removeButton.addEventListener('click', function () {
        rowElement.remove();
        refreshRemoveButtons();
      });
    }

    rowsContainer.querySelectorAll('.field-row').forEach(bindRow);

    addButton.addEventListener('click', function () {
      var fragment = rowTemplate.content.cloneNode(true);
      var rowElement = fragment.querySelector('.field-row');
      bindRow(rowElement);
      rowsContainer.appendChild(fragment);
      refreshRemoveButtons();
    });

    if (rowsContainer.children.length === 0) {
      addButton.click();
    }

    refreshRemoveButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFieldBuilder);
    return;
  }

  initFieldBuilder();
})();
